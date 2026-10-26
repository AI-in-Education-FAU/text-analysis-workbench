import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApp } from '../AppContext.jsx';
import ItemModal from '../components/ItemModal.jsx';
import { Flags } from '../components/ResultsView.jsx';
import { api } from '../utils/api';
import { getFilterOptions } from '../utils/data';
import { exportRows, num } from '../utils/metrics';

const COLORS = ['#2f6fdb', '#e07a2f', '#2e9e5b', '#c0392b', '#8e44ad', '#16a2b8', '#b7791f', '#5d6d7e', '#d63384', '#20c997'];
const PAGE_SIZE = 25;
const FILTER_KEYS = ['task', 'target', 'projectId', 'runId', 'method', 'label', 'status', 'flag', 'decision', 'maxConfidence', 'source', 'sourceType', 'from', 'to', 'author', 'q', 'sort'];
const DEFAULTS = { task: 'sentiment', target: 'articles', flag: '', decision: 'unreviewed', status: 'ok', sort: 'confidence_asc' };
const SOURCE_TEXT = { machine: 'machine', validated: 'validated ✓', corrected: 'corrected ✎', rejected: 'rejected ✗' };

/** Converts nested {key: {label: n}} counts into recharts rows. */
function stacked(obj, keyName) {
  const labels = new Set();
  const rows = Object.entries(obj || {}).map(([k, v]) => {
    Object.keys(v).forEach((l) => labels.add(l));
    return { [keyName]: k, ...v };
  });
  return { rows, labels: [...labels] };
}

function StackedChart({ title, data, keyName, onPick, height = 260, vertical = false }) {
  const { rows, labels } = stacked(data, keyName);
  if (!rows.length) return null;
  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      <ResponsiveContainer width="100%" height={vertical ? Math.max(height, rows.length * 28) : height}>
        <BarChart data={rows} layout={vertical ? 'vertical' : 'horizontal'} margin={vertical ? { left: 30 } : undefined}>
          <CartesianGrid strokeDasharray="3 3" />
          {vertical ? <XAxis type="number" allowDecimals={false} /> : <XAxis dataKey={keyName} tick={{ fontSize: 11 }} />}
          {vertical ? <YAxis type="category" dataKey={keyName} width={150} tick={{ fontSize: 11 }} /> : <YAxis allowDecimals={false} />}
          <Tooltip />
          <Legend />
          {labels.map((l, i) => (
            <Bar key={l} dataKey={l} stackId="a" fill={COLORS[i % COLORS.length]} cursor={onPick ? 'pointer' : undefined} onClick={onPick ? (d) => onPick(d[keyName], l) : undefined} />
          ))}
        </BarChart>
      </ResponsiveContainer>
      {onPick && <p className="muted small" style={{ margin: 0 }}>Click a bar to filter the table.</p>}
    </div>
  );
}

function DecisionCell({ row, task, labels, onSaved }) {
  const [mode, setMode] = useState(null);
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState(null);

  const send = async (decision) => {
    setBusy(true);
    setError(null);
    try {
      await api.validate({ task, resultId: row.id, decision, correctedLabel: decision === 'correct' ? label : undefined, note: note || undefined });
      setMode(null);
      setNote('');
      setHistory(null);
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const showHistory = async () => {
    if (history) { setHistory(null); return; }
    try {
      setHistory(await api.validationHistory(task, row.id));
    } catch (e) {
      setError(e.message);
    }
  };

  if (row.status !== 'ok') return <span className="muted small">{row.status}{row.error ? `: ${row.error}` : ''}</span>;
  return (
    <div className="decision">
      {!mode && (
        <div className="row" style={{ gap: '0.25rem' }}>
          <button disabled={busy} onClick={() => send('approve')} title="Machine label is correct">Approve</button>
          <button disabled={busy} onClick={() => { setMode('correct'); setLabel(''); }}>Correct…</button>
          <button disabled={busy} onClick={() => setMode('reject')} title="Label is wrong and no valid label applies">Reject…</button>
          <button disabled={busy} onClick={() => setMode('exclude')} title="Item should be excluded from analysis (irrelevant, spam, duplicate)">Exclude…</button>
          {row.decision && <button className="link small" onClick={showHistory}>{history ? 'hide history' : 'history'}</button>}
        </div>
      )}
      {mode && (
        <div className="row" style={{ gap: '0.25rem' }}>
          {mode === 'correct' && (
            labels.length ? (
              <select value={label} onChange={(e) => setLabel(e.target.value)} style={{ width: 'auto' }}>
                <option value="">correct label…</option>
                {labels.filter((l) => l !== row.label).map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            ) : <input type="text" placeholder="correct label" value={label} onChange={(e) => setLabel(e.target.value)} style={{ width: 130 }} />
          )}
          <input type="text" placeholder={mode === 'correct' ? 'note (optional)' : 'reason / note'} value={note} onChange={(e) => setNote(e.target.value)} style={{ width: 160 }} />
          <button className="primary" disabled={busy || (mode === 'correct' && !label)} onClick={() => send(mode)}>Save {mode}</button>
          <button onClick={() => setMode(null)}>Cancel</button>
        </div>
      )}
      {error && <div className="bad-text small">{error}</div>}
      {history && (
        <ul className="small history">
          {history.map((h) => (
            <li key={h.id}>{new Date(h.created_at).toLocaleString()} · <strong>{h.decision}</strong>{h.corrected_label ? ` → ${h.corrected_label}` : ''} · {h.reviewer_email || 'unknown'}{h.note ? ` — “${h.note}”` : ''}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** FR-24/25/28/29/32: browse, chart, validate and export saved analysis results. */
export default function Review() {
  const { serverConfig, projects, projectId: activeProjectId } = useApp();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => {
    const f = { ...DEFAULTS, projectId: activeProjectId || '' };
    for (const k of FILTER_KEYS) if (params.has(k)) f[k] = params.get(k);
    return f;
  }, [params, activeProjectId]);
  const [draft, setDraft] = useState(filters);
  const [page, setPage] = useState(0);
  const [data, setData] = useState(null);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(null);
  const [options, setOptions] = useState({ sources: [], sourceTypes: [] });
  const [exporting, setExporting] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => setDraft(filters), [filters]);
  useEffect(() => { getFilterOptions().then(setOptions).catch(() => {}); }, []);

  const task = serverConfig?.tasks.find((t) => t.id === filters.task);
  const query = useMemo(() => Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== '' && v !== undefined)), [filters]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.results({ ...query, page, pageSize: PAGE_SIZE })
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [query, page, tick]);

  useEffect(() => {
    let cancelled = false;
    const { decision, sort, ...rest } = query;
    api.resultsSummary(rest).then((s) => !cancelled && setSummary(s)).catch(() => !cancelled && setSummary(null));
    return () => { cancelled = true; };
  }, [query, tick]);

  const apply = (next) => {
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== '' && v !== undefined && v !== null));
    if (next.flag === '') clean.flag = '';
    if (next.decision === '') clean.decision = '';
    if (next.status === '') clean.status = '';
    setParams(clean);
    setPage(0);
  };
  const set = (k) => (e) => setDraft({ ...draft, [k]: e.target.value });
  const pick = (k, v) => apply({ ...filters, [k]: v });
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const labels = useMemo(() => task?.labels || Object.keys(summary?.byLabel || {}).filter((l) => !l.startsWith('(')), [task, summary]);
  const methodOptions = task?.methods || [];
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  const exportAll = async (format) => {
    setExporting(true);
    setError(null);
    try {
      const rows = [];
      for (let p = 0; p < 20; p++) {
        const d = await api.results({ ...query, page: p, pageSize: 1000 });
        rows.push(...d.rows);
        if (rows.length >= d.total || d.rows.length < 1000) break;
      }
      const header = ['result_id', 'run_id', 'task', 'method', 'method_version', 'item_type', 'item_id', 'article_id', 'parent_comment_id', 'date', 'source', 'source_type',
        'author_pseudonym', 'title', 'snippet', 'machine_label', 'confidence', 'status', 'flags', 'target_type', 'target_id', 'decision', 'corrected_label', 'final_label', 'label_source', 'reviewer', 'review_note', 'reviewed_at'];
      const out = rows.map((r) => [r.id, r.runId, filters.task, r.method, r.methodVersion, r.item.type, r.item.id, r.item.article_id, r.item.parent_comment_id, r.item.date, r.item.source, r.item.source_type,
        r.item.author, r.item.title, r.item.snippet, r.label, r.confidence, r.status, r.flags, r.targetType, r.targetId, r.decision?.decision, r.decision?.correctedLabel, r.finalLabel, r.labelSource,
        r.decision?.reviewer, r.decision?.note, r.decision?.at]);
      exportRows(format, `${filters.task}-${filters.target}-review-${new Date().toISOString().slice(0, 10)}`, header, out, { filters: JSON.stringify(query), count: out.length });
    } catch (e) {
      setError(e.message);
    } finally {
      setExporting(false);
    }
  };

  if (!serverConfig) return <><h1>Review results</h1><p className="muted">Connecting to the analysis server…</p></>;

  const byLabelRows = Object.entries(summary?.byLabel || {}).map(([label, n]) => ({ label, n }));

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Review results</h1>
          <p className="muted">Filter saved results, inspect flagged items, and record validation decisions. Decisions are stored separately — the original machine output is never overwritten.</p>
        </div>
      </div>

      <form className="panel filters" onSubmit={(e) => { e.preventDefault(); apply(draft); }}>
        <label className="field">Task
          <select value={draft.task} onChange={(e) => setDraft({ ...draft, task: e.target.value, method: '', label: '' })}>
            {serverConfig.tasks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label className="field">Unit
          <select value={draft.target} onChange={set('target')}>
            <option value="articles">Articles</option>
            <option value="comments">Comments</option>
          </select>
        </label>
        <label className="field">Project
          <select value={draft.projectId || ''} onChange={set('projectId')}>
            <option value="">All my runs</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="field">Method
          <select value={draft.method || ''} onChange={set('method')}>
            <option value="">All</option>
            {methodOptions.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <label className="field">Machine label
          <select value={draft.label || ''} onChange={set('label')}>
            <option value="">All</option>
            {labels.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <label className="field">Flag
          <select value={draft.flag || ''} onChange={set('flag')}>
            <option value="">Any or none</option>
            <option value="any">Any flag</option>
            <option value="low_confidence">Low confidence</option>
            <option value="conflict">Methods disagree</option>
            <option value="failed">Failed</option>
          </select>
        </label>
        <label className="field">Review status
          <select value={draft.decision || ''} onChange={set('decision')}>
            <option value="">All</option>
            <option value="unreviewed">Unreviewed</option>
            <option value="approve">Approved</option>
            <option value="correct">Corrected</option>
            <option value="reject">Rejected</option>
            <option value="exclude">Excluded</option>
          </select>
        </label>
        <label className="field">Result status
          <select value={draft.status || ''} onChange={set('status')}>
            <option value="">All</option>
            <option value="ok">Labelled</option>
            <option value="failed">Failed</option>
            <option value="ineligible">Ineligible</option>
          </select>
        </label>
        <label className="field">Max confidence<input type="number" min={0} max={1} step={0.05} value={draft.maxConfidence || ''} onChange={set('maxConfidence')} /></label>
        <label className="field">Source
          <select value={draft.source || ''} onChange={set('source')}>
            <option value="">All</option>
            {options.sources.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <label className="field">Source type
          <select value={draft.sourceType || ''} onChange={set('sourceType')}>
            <option value="">All</option>
            {options.sourceTypes.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <label className="field">From<input type="date" value={draft.from || ''} onChange={set('from')} /></label>
        <label className="field">To<input type="date" value={draft.to || ''} onChange={set('to')} /></label>
        {draft.target === 'articles' && <label className="field">Author contains<input type="text" value={draft.author || ''} onChange={set('author')} /></label>}
        <label className="field">{draft.target === 'comments' ? 'Comment text' : 'Title'} contains<input type="search" value={draft.q || ''} onChange={set('q')} /></label>
        <label className="field">Sort
          <select value={draft.sort || ''} onChange={set('sort')}>
            <option value="confidence_asc">Lowest confidence first</option>
            <option value="confidence_desc">Highest confidence first</option>
            <option value="">Newest first</option>
          </select>
        </label>
        <div className="row">
          <button className="primary" type="submit">Apply</button>
          <button type="button" onClick={() => apply({ ...DEFAULTS, task: draft.task, target: draft.target, projectId: activeProjectId || '' })}>Reset</button>
        </div>
      </form>
      {filters.runId && <div className="alert info row">Showing run #{filters.runId} only. <button className="link" onClick={() => pick('runId', '')}>Show all runs</button></div>}

      {summary?.total > 0 && (
        <>
          <div className="stats">
            <div className="stat"><strong>{summary.total.toLocaleString()}</strong><span>results{summary.truncated ? ' (first 20k)' : ''}</span></div>
            {Object.entries(summary.status).map(([k, v]) => <div className="stat" key={k}><strong>{v}</strong><span>{k}</span></div>)}
            {Object.entries(summary.flags).map(([k, v]) => (
              <button className="stat" key={k} onClick={() => pick('flag', k)}><strong>{v}</strong><span>⚑ {k.replace('_', ' ')}</span></button>
            ))}
            {Object.entries(summary.validated).map(([k, v]) => (
              <button className="stat" key={k} onClick={() => pick('decision', k)}><strong>{v}</strong><span>{k}</span></button>
            ))}
          </div>
          <div className="grid cols-2">
            <div className="panel">
              <h3 style={{ marginTop: 0 }}>Machine labels</h3>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={byLabelRows}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="label" interval={0} tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="n" name="results" fill={COLORS[0]} cursor="pointer" onClick={(d) => pick('label', d?.payload?.label ?? d?.label)} />
                </BarChart>
              </ResponsiveContainer>
              <p className="muted small" style={{ margin: 0 }}>Click a bar to filter the table.</p>
            </div>
            <StackedChart title="Over time (by month)" data={summary.byMonth} keyName="month" />
            <StackedChart title="By method" data={summary.byMethod} keyName="method" onPick={(m, l) => apply({ ...filters, method: m, label: l })} vertical />
            <StackedChart title="By source" data={summary.bySource} keyName="source" onPick={(s, l) => apply({ ...filters, source: s === 'unknown' ? '' : s, label: l })} vertical />
          </div>
          <p className="muted small">Charts summarize all results matching the filters (ignoring the review-status filter). Counts describe the collected sample, not the population.</p>
        </>
      )}

      <div className="row" style={{ margin: '1rem 0 0.5rem' }}>
        <h3 style={{ margin: 0 }}>Results</h3>
        <span className="muted">{data ? `${data.total.toLocaleString()} matching` : ''}</span>
        <span className="spacer" />
        <span className="muted small">Export filtered set (authors pseudonymized):</span>
        {['csv', 'json', 'xml'].map((f) => <button key={f} disabled={exporting || !data?.total} onClick={() => exportAll(f)}>{f.toUpperCase()}</button>)}
      </div>
      {error && <div className="alert error">{error}</div>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Item</th><th>Method</th><th>Machine output</th><th>Final label</th><th style={{ minWidth: 280 }}>Validation</th></tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={5} className="muted">Loading…</td></tr>}
            {!loading && data && !data.rows.length && <tr><td colSpan={5} className="muted">No results match these filters.</td></tr>}
            {!loading && data?.rows.map((r) => (
              <tr key={r.id}>
                <td style={{ maxWidth: 420 }}>
                  <button className="link" onClick={() => setOpen({ target: r.item.type === 'comment' ? 'comments' : 'articles', id: r.item.id })}>#{r.item.id}</button>{' '}
                  <span className="muted small">{r.item.date} · {r.item.source}{r.item.author ? ` · ${r.item.author}` : ''}{r.item.parent_comment_id ? ` · reply to #${r.item.parent_comment_id}` : ''}</span>
                  {r.item.title && <div><strong className="small">{r.item.title}</strong></div>}
                  <div className="clamp small">{r.item.snippet}</div>
                </td>
                <td className="small">{r.methodName}<div className="muted mono">{r.methodVersion || ''} · run #{r.runId}</div></td>
                <td>
                  {r.status === 'ok' ? <span className={`tag ${String(r.label).toLowerCase()}`}>{r.label}</span> : <span className="tag err">{r.status}</span>}
                  {' '}<span className="muted small">{num(r.confidence)}</span>
                  {r.targetType && <div className="muted small">→ {r.targetType} #{r.targetId}</div>}
                  <div><Flags flags={r.flags} /></div>
                  {(r.rationale || r.evidence) && (
                    <details className="small"><summary>why</summary>{r.evidence && <div className="evidence">“{r.evidence}”</div>}{r.rationale && <div className="muted">{r.rationale}</div>}</details>
                  )}
                </td>
                <td>
                  {r.finalLabel ? <span className={`tag ${String(r.finalLabel).toLowerCase()}`}>{r.finalLabel}</span> : <span className="muted">—</span>}
                  <div className={`small label-source ${r.labelSource}`}>{SOURCE_TEXT[r.labelSource]}{r.decision?.reviewer ? ` by ${r.decision.reviewer}` : ''}</div>
                  {r.decision?.note && <div className="muted small">“{r.decision.note}”</div>}
                </td>
                <td><DecisionCell row={r} task={filters.task} labels={labels} onSaved={refresh} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ marginTop: '0.5rem' }}>
        <button onClick={() => setPage(page - 1)} disabled={page === 0}>‹ Prev</button>
        <span className="muted">Page {page + 1} of {pages}</span>
        <button onClick={() => setPage(page + 1)} disabled={page + 1 >= pages}>Next ›</button>
      </div>

      {open && <ItemModal target={open.target} id={open.id} onClose={() => setOpen(null)} />}
    </>
  );
}
