import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApp } from '../AppContext.jsx';
import ItemModal from './ItemModal.jsx';
import { api } from '../utils/api';
import { downloadFile, evaluate, exportRows, hasLabel, num, pairwiseAgreement, pct, sampleIndices } from '../utils/metrics';

const COLORS = ['#2f6fdb', '#e07a2f', '#2e9e5b', '#c0392b', '#8e44ad', '#16a2b8', '#b7791f', '#5d6d7e', '#d63384', '#20c997'];
const PAGE = 50;
const STATISTICAL_TOPICS = ['lda', 'nmf'];
const FLAG_TEXT = { low_confidence: 'low confidence', conflict: 'methods disagree', failed: 'failed' };

function Tag({ label }) {
  return <span className={`tag ${String(label).toLowerCase()}`}>{label}</span>;
}

export function Flags({ flags }) {
  if (!flags?.length) return null;
  return flags.map((f) => <span key={f} className={`tag flag ${f}`} title={FLAG_TEXT[f] || f}>⚑ {FLAG_TEXT[f] || f}</span>);
}

const baseMethodId = (id) => String(id).split('#')[0];

/** Reference (human-coded) labels stored in Supabase for the items of this result (FR-23). */
function useReferenceLabels(task, target, items, labelSource, guideVersion) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const itemType = target === 'comments' ? 'comment' : 'article';
  const ids = useMemo(() => items.map((it) => it.id).join(','), [items]);

  const reload = useCallback(() => {
    if (!ids) return;
    api.referenceLabels({ task, itemType, ids, labelSource, guideVersion: guideVersion || undefined })
      .then((r) => { setRows(r); setError(null); })
      .catch((e) => setError(e.message));
  }, [task, itemType, ids, labelSource, guideVersion]);

  useEffect(reload, [reload]);
  return { rows, setRows, error, reload, itemType };
}

export default function ResultsView({ result, taskLabels }) {
  const { items, methods, task } = result;
  const { user } = useApp();
  const me = user?.email || '';
  const [labelSource, setLabelSource] = useState('team');
  const [guideVersion, setGuideVersion] = useState('v1');
  const [annotatorView, setAnnotatorView] = useState('me');
  const ref = useReferenceLabels(task, result.target, items, labelSource, guideVersion);
  const [onlyDisagree, setOnlyDisagree] = useState(false);
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [sampleSize, setSampleSize] = useState(0);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState(null);
  const [evalMethod, setEvalMethod] = useState(0);
  const [trendMethod, setTrendMethod] = useState(0);
  const [saveError, setSaveError] = useState(null);

  const labels = useMemo(() => {
    if (taskLabels?.length) return taskLabels;
    const set = new Set();
    if (task === 'codebook') {
      String(result.options?.codebook || '').split('\n').map((l) => l.split(':')[0].trim()).filter(Boolean).forEach((l) => set.add(l));
    }
    if (task === 'topics' && result.options?.labels) {
      String(result.options.labels).split(/[,\n]/).map((l) => l.trim()).filter(Boolean).forEach((l) => set.add(l));
    }
    methods.forEach((m) => m.results.forEach((r) => hasLabel(r) && set.add(r.label)));
    return [...set].sort();
  }, [methods, taskLabels, task, result.options]);

  const sharedLabelSpace = task !== 'topics' || methods.every((m) => !STATISTICAL_TOPICS.includes(baseMethodId(m.methodId)));

  // Gold label per item: the signed-in annotator's label, or (for "all") the most common label across annotators.
  const gold = useMemo(() => {
    const byItem = new Map();
    for (const r of ref.rows) {
      if (!byItem.has(r.item_id)) byItem.set(r.item_id, []);
      byItem.get(r.item_id).push(r);
    }
    const out = {};
    for (const [id, rs] of byItem) {
      if (labelSource === 'team' && annotatorView === 'me') {
        const mine = rs.find((r) => r.annotator === me);
        if (mine) out[id] = { label: mine.label, row: mine };
      } else {
        const counts = {};
        rs.forEach((r) => { counts[r.label] = (counts[r.label] || 0) + 1; });
        const label = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
        out[id] = { label, row: rs.find((r) => r.annotator === me) || null, n: rs.length };
      }
    }
    return out;
  }, [ref.rows, labelSource, annotatorView, me]);

  const annotators = useMemo(() => [...new Set(ref.rows.map((r) => r.annotator))], [ref.rows]);

  const setHumanLabel = async (it, label) => {
    setSaveError(null);
    try {
      const existing = ref.rows.find((r) => r.item_id === it.id && r.annotator === me && r.label_source === 'team');
      if (!label) {
        if (existing) await api.deleteReferenceLabel(existing.id);
        ref.setRows(ref.rows.filter((r) => r !== existing));
        return;
      }
      const [saved] = await api.saveReferenceLabels({
        task,
        itemType: ref.itemType,
        projectId: result.projectId || undefined,
        guideVersion,
        labelSource: 'team',
        labels: [{ itemId: it.id, articleId: it.article_id, label }],
      });
      ref.setRows([...ref.rows.filter((r) => r.id !== saved.id), saved]);
    } catch (e) {
      setSaveError(e.message);
    }
  };

  const distribution = useMemo(() => {
    const rows = new Map();
    methods.forEach((m, mi) => m.results.forEach((r) => {
      if (!hasLabel(r)) return;
      if (!rows.has(r.label)) rows.set(r.label, { label: r.label });
      const row = rows.get(r.label);
      row[`m${mi}`] = (row[`m${mi}`] || 0) + 1;
    }));
    const order = (l) => (labels.indexOf(l) === -1 ? 999 : labels.indexOf(l));
    return [...rows.values()].sort((a, b) => order(a.label) - order(b.label) || a.label.localeCompare(b.label));
  }, [methods, labels]);

  const agreement = useMemo(() => (methods.length > 1 && sharedLabelSpace ? pairwiseAgreement(methods) : []), [methods, sharedLabelSpace]);

  const trend = useMemo(() => {
    const m = methods[trendMethod];
    if (!m) return { rows: [], keys: [] };
    const byMonth = new Map();
    const keys = new Set();
    items.forEach((it, i) => {
      const r = m.results[i];
      if (!it.date || !hasLabel(r)) return;
      const month = String(it.date).slice(0, 7);
      if (!byMonth.has(month)) byMonth.set(month, { month });
      byMonth.get(month)[r.label] = (byMonth.get(month)[r.label] || 0) + 1;
      keys.add(r.label);
    });
    return { rows: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)), keys: [...keys] };
  }, [items, methods, trendMethod]);

  const goldArray = useMemo(() => items.map((it) => gold[it.id]?.label || null), [items, gold]);
  const codedCount = goldArray.filter(Boolean).length;
  const evaluation = useMemo(
    () => (codedCount ? methods.map((m) => evaluate(m.results, goldArray, labels)) : []),
    [methods, goldArray, labels, codedCount],
  );
  const bestF1 = Math.max(...evaluation.map((e) => e.macroF1 ?? -1));

  const sampleSet = useMemo(() => (sampleSize ? new Set(sampleIndices(items.length, sampleSize, 7)) : null), [items.length, sampleSize]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.map((it, i) => i).filter((i) => {
      if (sampleSet && !sampleSet.has(i)) return false;
      if (q && !`${items[i].title} ${items[i].snippet}`.toLowerCase().includes(q)) return false;
      if (onlyFlagged && !methods.some((m) => m.results[i]?.flags?.length)) return false;
      if (onlyDisagree) {
        const ls = new Set(methods.map((m) => m.results[i]).filter(hasLabel).map((r) => r.label));
        if (ls.size < 2) return false;
      }
      return true;
    });
  }, [items, methods, search, onlyDisagree, onlyFlagged, sampleSet]);

  useEffect(() => setPage(0), [search, onlyDisagree, onlyFlagged, sampleSize]);
  const pageRows = visible.slice(page * PAGE, (page + 1) * PAGE);
  const pages = Math.max(1, Math.ceil(visible.length / PAGE));

  const exportAs = (format) => {
    const header = ['id', 'type', 'article_id', 'parent_comment_id', 'date', 'source', 'source_type', 'title', 'snippet', 'reference_label'];
    methods.forEach((m) => {
      const p = m.methodId;
      header.push(`${p}_status`, `${p}_label`, `${p}_confidence`, `${p}_flags`, `${p}_score`, `${p}_evidence`, `${p}_evidence_verified`, `${p}_rationale`, `${p}_target_type`, `${p}_target_id`, `${p}_error`);
    });
    const rows = items.map((it, i) => {
      const row = [it.id, it.type, it.article_id, it.parent_comment_id, it.date, it.source, it.source_type, it.title, it.snippet, gold[it.id]?.label || ''];
      methods.forEach((m) => {
        const r = m.results[i] || {};
        const status = r.error ? 'failed' : r.status === 'ineligible' ? 'ineligible' : 'ok';
        row.push(status, r.label, r.confidence, r.flags, r.score, r.evidence, r.evidenceVerified, r.rationale, r.targetType, r.targetId, r.error || r.reason);
      });
      return row;
    });
    const meta = {
      task,
      target: result.target,
      projectId: result.projectId ?? '',
      methods: methods.map((m) => `${m.methodId}@${m.version || ''}`).join(', '),
      options: JSON.stringify(result.options || {}),
    };
    exportRows(format, `${task}-${result.target}-${new Date().toISOString().slice(0, 10)}`, header, rows, meta);
  };

  const exportReport = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      ...result,
      referenceLabels: ref.rows,
      agreement,
      evaluation: evaluation.map((e, i) => ({ method: methods[i].methodId, baseline: methods[i].baseline, n: e.n, accuracy: e.accuracy, macroF1: e.macroF1, perClass: e.perClass })),
    };
    downloadFile(`${task}-${result.target}-report.json`, JSON.stringify(payload, null, 2), 'application/json');
  };

  const savedRunIds = methods.map((m) => m.runId).filter(Boolean);

  return (
    <div>
      <div className="row" style={{ marginBottom: '0.5rem' }}>
        <h2 style={{ margin: 0 }}>Results</h2>
        <span className="muted">{items.length} {result.target} · {methods.length} method(s)</span>
        <span className="spacer" />
        {savedRunIds.length > 0 && <Link className="button" to={`/review?task=${task}&target=${result.target}&runId=${savedRunIds[0]}`}>Review &amp; validate →</Link>}
        <span className="muted small">Export:</span>
        <button onClick={() => exportAs('csv')}>CSV</button>
        <button onClick={() => exportAs('json')}>JSON</button>
        <button onClick={() => exportAs('xml')}>XML</button>
        <button onClick={exportReport} title="Full run including settings, evaluation and agreement">Report (JSON)</button>
      </div>

      <div className="table-wrap" style={{ marginBottom: '1rem' }}>
        <table>
          <thead>
            <tr>
              <th>Method</th><th>Status</th><th className="num">Labelled</th><th className="num">Ineligible</th><th className="num">Failed</th>
              <th className="num">Coverage</th><th className="num">Failure rate</th><th className="num">Flagged</th><th className="num">Mean conf.</th>
              <th className="num">Time</th><th>Version / settings</th><th>Saved</th>
            </tr>
          </thead>
          <tbody>
            {methods.map((m) => {
              const s = m.summary || {};
              return (
                <tr key={m.methodId}>
                  <td><strong>{m.methodName}</strong> {m.baseline ? <span className="tag baseline">baseline</span> : m.kind === 'llm' || m.kind === 'transformer' ? <span className="tag kind">AI</span> : null}</td>
                  <td><span className={`tag status-${m.status || 'completed'}`}>{m.status || 'completed'}</span></td>
                  <td className="num">{s.analyzed}</td>
                  <td className="num">{s.ineligible || 0}</td>
                  <td className="num">{s.errors ? <span className="bad-text">{s.errors}</span> : 0}</td>
                  <td className="num">{pct(s.coverage, 1)}</td>
                  <td className="num">{pct(s.failureRate, 1)}</td>
                  <td className="num">{s.flagged ?? '—'}</td>
                  <td className="num">{num(s.meanConfidence)}</td>
                  <td className="num">{s.durationMs ? `${(s.durationMs / 1000).toFixed(1)}s` : '—'}</td>
                  <td className="small mono">
                    {[m.version, s.model, s.target && `target: ${s.target}`, s.seed !== undefined && `seed ${s.seed}`, Number.isFinite(s.meanCoherence) && `UMass ${num(s.meanCoherence)}`].filter(Boolean).join(' · ') || '—'}
                  </td>
                  <td>{m.runId ? <Link to={`/runs/${m.runId}`}>saved ✓</Link> : m.saveError ? <span className="bad-text small" title={m.saveError}>failed</span> : <span className="muted">no</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {methods.filter((m) => m.saveError).map((m) => <div key={m.methodId} className="alert error">Saving {m.methodName} failed: {m.saveError}</div>)}
      {methods.map((m) => {
        const firstErr = m.results.find((r) => r?.error);
        return firstErr ? <div key={`e${m.methodId}`} className="alert warn">{m.methodName}: {m.summary?.errors} item(s) failed — e.g. “{firstErr.error}”</div> : null;
      })}
      {methods.some((m) => m.summary?.ineligible) && (
        <div className="alert info">Some items were not eligible for this task (e.g. conversational stance needs a comment with a parent article or comment). They are excluded from coverage.</div>
      )}

      <div className="grid cols-2">
        {sharedLabelSpace ? (
          <div className="panel">
            <h3 style={{ marginTop: 0 }}>Label distribution</h3>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={distribution}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" interval={0} tick={{ fontSize: 11 }} />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Legend />
                {methods.map((m, i) => <Bar key={m.methodId} dataKey={`m${i}`} name={m.methodName} fill={COLORS[i % COLORS.length]} />)}
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : methods.map((m, mi) => (
          <div className="panel" key={m.methodId}>
            <h3 style={{ marginTop: 0 }}>{m.methodName}: documents per topic</h3>
            <ResponsiveContainer width="100%" height={Math.max(200, distribution.filter((d) => d[`m${mi}`]).length * 32)}>
              <BarChart data={distribution.filter((d) => d[`m${mi}`])} layout="vertical" margin={{ left: 40 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" allowDecimals={false} />
                <YAxis type="category" dataKey="label" width={180} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey={`m${mi}`} name="documents" fill={COLORS[mi % COLORS.length]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ))}

        {trend.rows.length > 1 && (
          <div className="panel">
            <div className="row">
              <h3 style={{ margin: 0 }}>Over time (by month)</h3>
              <span className="spacer" />
              {methods.length > 1 && (
                <select value={trendMethod} onChange={(e) => setTrendMethod(Number(e.target.value))} style={{ width: 'auto' }}>
                  {methods.map((m, i) => <option key={m.methodId} value={i}>{m.methodName}</option>)}
                </select>
              )}
            </div>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={trend.rows}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Legend />
                {trend.keys.map((k, i) => <Bar key={k} dataKey={k} stackId="a" fill={COLORS[i % COLORS.length]} />)}
              </BarChart>
            </ResponsiveContainer>
            <p className="muted small">Counts reflect your sample and the method’s errors, not the population. Don’t infer causes from trends alone.</p>
          </div>
        )}
      </div>

      {methods.some((m) => m.summary?.topics?.length) && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Topics</h3>
          {methods.filter((m) => m.summary?.topics?.length).map((m) => {
            const coh = new Map((m.summary.coherence || []).map((c) => [c.label, c.coherence]));
            return (
              <div key={m.methodId}>
                <h4 style={{ margin: '0.5rem 0' }}>{m.methodName} {Number.isFinite(m.summary.meanCoherence) && <span className="muted small">mean UMass coherence {num(m.summary.meanCoherence)}</span>}</h4>
                <table>
                  <thead><tr><th>Topic</th><th>Top terms</th><th className="num">Docs</th><th className="num" title="UMass coherence: closer to 0 = terms co-occur more often">Coherence</th></tr></thead>
                  <tbody>
                    {m.summary.topics.map((t) => (
                      <tr key={t.label}><td>{t.label}</td><td className="small">{t.keywords?.join(', ') || '—'}</td><td className="num">{m.summary.counts?.[t.label] || 0}</td><td className="num">{num(coh.get(t.label))}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
          <p className="muted small">Topics are analyst-interpreted patterns. Read representative documents before naming them, and check stability across seeds and topic counts. UMass coherence is ≤ 0; values closer to 0 indicate more coherent topics.</p>
        </div>
      )}

      {agreement.length > 0 && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Agreement between methods</h3>
          <table>
            <thead><tr><th>Method A</th><th>Method B</th><th className="num">Items</th><th className="num">% agreement</th><th className="num">Cohen’s κ</th></tr></thead>
            <tbody>
              {agreement.map((p) => (
                <tr key={`${p.a}-${p.b}`}><td>{p.a}</td><td>{p.b}</td><td className="num">{p.n}</td><td className="num">{pct(p.agreement, 1)}</td><td className="num">{num(p.kappa)}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">Agreement between methods is not accuracy. Low κ means at least one method is unreliable for this data — validate against the human reference sample below.</p>
        </div>
      )}

      <div className="panel">
        <div className="row">
          <h3 style={{ margin: 0 }}>Evaluation against the human reference sample</h3>
          <span className="muted">{codedCount} item(s) with reference labels</span>
          <span className="spacer" />
          <label className="check small">Source
            <select value={labelSource} onChange={(e) => setLabelSource(e.target.value)} style={{ width: 'auto' }}>
              <option value="team">Team coding</option>
              <option value="partner">Partner labels</option>
            </select>
          </label>
          {labelSource === 'team' && (
            <label className="check small">Annotator
              <select value={annotatorView} onChange={(e) => setAnnotatorView(e.target.value)} style={{ width: 'auto' }}>
                <option value="me">Me ({me || 'unknown'})</option>
                <option value="all">All annotators (majority)</option>
              </select>
            </label>
          )}
          <label className="check small">Guide version<input type="text" value={guideVersion} onChange={(e) => setGuideVersion(e.target.value.trim())} style={{ width: 70 }} /></label>
          <label className="check small">Coding sample
            <select value={sampleSize} onChange={(e) => setSampleSize(Number(e.target.value))} style={{ width: 'auto' }}>
              <option value={0}>— all items —</option>
              {[20, 50, 100, 200, 250, 300].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
        <p className="muted small">
          Code items in the “Reference label” column (ideally blind, before reading model labels). Labels are saved to Supabase per annotator and guide version, so the same sample can be re-used across runs.
          The proposal targets a reference sample of 200–300 units. Partner labels can be imported on the <Link to="/reference">Reference labels</Link> page.
          {annotators.length > 1 && ` Annotators on these items: ${annotators.join(', ')}.`}
        </p>
        {ref.error && <div className="alert error">{ref.error}</div>}
        {saveError && <div className="alert error">{saveError}</div>}
        {!sharedLabelSpace && <p className="muted small">Unsupervised topics (LDA/NMF) have no fixed label set, so accuracy is only meaningful if you code with the same topic names.</p>}
        {codedCount > 0 && (
          <>
            <table>
              <thead><tr><th>Method</th><th>Type</th><th className="num">Coded items</th><th className="num">Accuracy</th><th className="num">Macro-F1</th><th className="num">Coverage</th><th className="num">Time</th></tr></thead>
              <tbody>
                {evaluation.map((e, i) => (
                  <tr key={methods[i].methodId} className={e.macroF1 === bestF1 && evaluation.length > 1 ? 'selected' : ''}>
                    <td>{methods[i].methodName}</td>
                    <td>{methods[i].baseline ? 'traditional baseline' : 'AI / model'}</td>
                    <td className="num">{e.n}</td>
                    <td className="num">{pct(e.accuracy, 1)}</td>
                    <td className="num">{num(e.macroF1)}</td>
                    <td className="num">{pct(methods[i].summary?.coverage, 1)}</td>
                    <td className="num">{methods[i].summary?.durationMs ? `${(methods[i].summary.durationMs / 1000).toFixed(1)}s` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {methods.some((m) => m.baseline) && methods.some((m) => !m.baseline) && (
              <p className="muted small">The highlighted row has the best macro-F1. Compare AI methods with the traditional baseline on accuracy, coverage and processing time before choosing one for the full corpus.</p>
            )}
            {evaluation[evalMethod] && (
              <>
                <div className="row" style={{ marginTop: '1rem' }}>
                  <strong>Details for</strong>
                  <select value={evalMethod} onChange={(e) => setEvalMethod(Number(e.target.value))} style={{ width: 'auto' }}>
                    {methods.map((m, i) => <option key={m.methodId} value={i}>{m.methodName}</option>)}
                  </select>
                </div>
                <div className="grid cols-2" style={{ marginTop: '0.5rem' }}>
                  <table>
                    <thead><tr><th>Class</th><th className="num">Precision</th><th className="num">Recall</th><th className="num">F1</th><th className="num">Support</th></tr></thead>
                    <tbody>
                      {evaluation[evalMethod].perClass.map((c) => (
                        <tr key={c.label}><td><Tag label={c.label} /></td><td className="num">{num(c.precision)}</td><td className="num">{num(c.recall)}</td><td className="num">{num(c.f1)}</td><td className="num">{c.support}</td></tr>
                      ))}
                    </tbody>
                  </table>
                  <div style={{ overflow: 'auto' }}>
                    <table className="matrix">
                      <thead>
                        <tr><th>human ↓ / model →</th>{evaluation[evalMethod].labels.map((l) => <th key={l}>{l}</th>)}</tr>
                      </thead>
                      <tbody>
                        {evaluation[evalMethod].labels.map((g) => (
                          <tr key={g}>
                            <th>{g}</th>
                            {evaluation[evalMethod].labels.map((p) => (
                              <td key={p} className={g === p ? 'diag' : ''}>{evaluation[evalMethod].matrix[g][p] || ''}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
            {codedCount < 30 && <p className="muted small">Fewer than 30 coded items — treat these scores as very uncertain.</p>}
          </>
        )}
      </div>

      <div className="row" style={{ margin: '1rem 0 0.5rem' }}>
        <h3 style={{ margin: 0 }}>Item-level results</h3>
        <span className="muted">{visible.length} shown</span>
        <span className="spacer" />
        <input type="search" placeholder="Filter text…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 200 }} />
        <label className="check"><input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} /> Only flagged</label>
        {methods.length > 1 && (
          <label className="check"><input type="checkbox" checked={onlyDisagree} onChange={(e) => setOnlyDisagree(e.target.checked)} /> Only disagreements</label>
        )}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Item</th>
              {methods.map((m) => <th key={m.methodId}>{m.methodName}</th>)}
              <th style={{ width: 160 }}>Reference label</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((i) => {
              const it = items[i];
              const g = gold[it.id];
              const editable = labelSource === 'team';
              return (
                <Fragment key={it.id}>
                  <tr>
                    <td style={{ maxWidth: 460 }}>
                      <button className="link" onClick={() => setOpen(it.id)}>#{it.id}</button>{' '}
                      <span className="muted small">{it.date} {it.source}{it.parent_comment_id ? ` · reply to #${it.parent_comment_id}` : ''}</span>
                      {it.title && <div><strong className="small">{it.title}</strong></div>}
                      <div className="clamp small">{it.snippet}</div>
                    </td>
                    {methods.map((m) => {
                      const r = m.results[i];
                      if (!r) return <td key={m.methodId} className="muted">—</td>;
                      if (r.status === 'ineligible') return <td key={m.methodId}><span className="tag" title={r.reason || 'not eligible for this task'}>n/a</span></td>;
                      if (r.error) return <td key={m.methodId}><span className="tag err" title={r.error}>failed</span></td>;
                      return (
                        <td key={m.methodId}>
                          <Tag label={r.label} /> <span className="muted small">{num(r.confidence)}</span>
                          {r.targetType && <div className="muted small">→ {r.targetType} #{r.targetId}</div>}
                          <div><Flags flags={r.flags} /></div>
                          {(r.rationale || r.evidence) && (
                            <details className="small">
                              <summary>why</summary>
                              {r.evidence && (
                                <div className="evidence">
                                  “{r.evidence}” {r.evidenceVerified === true && <span className="ok-text" title="Quote found in the text">✓</span>}
                                  {r.evidenceVerified === false && <span className="bad-text" title="Quote NOT found verbatim in the text">✗ unverified</span>}
                                </div>
                              )}
                              {r.rationale && <div className="muted">{r.rationale}</div>}
                            </details>
                          )}
                        </td>
                      );
                    })}
                    <td>
                      {editable && annotatorView === 'me' ? (
                        <select value={g?.label || ''} onChange={(e) => setHumanLabel(it, e.target.value)}>
                          <option value="">—</option>
                          {labels.map((l) => <option key={l} value={l}>{l}</option>)}
                        </select>
                      ) : g ? (
                        <span><Tag label={g.label} />{g.n > 1 && <span className="muted small"> ({g.n} coders)</span>}</span>
                      ) : <span className="muted">—</span>}
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ marginTop: '0.5rem' }}>
        <button onClick={() => setPage(page - 1)} disabled={page === 0}>‹ Prev</button>
        <span className="muted">Page {page + 1} of {pages}</span>
        <button onClick={() => setPage(page + 1)} disabled={page + 1 >= pages}>Next ›</button>
      </div>

      {open !== null && <ItemModal target={result.target} id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
