import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../AppContext.jsx';
import { api } from '../utils/api';
import { exportRows, num, pairwiseAgreement, pct } from '../utils/metrics';

/** Minimal RFC-4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const guess = (header, names) => header.findIndex((h) => names.includes(h.trim().toLowerCase()));

/** FR-23: manage the human reference sample (team coding and partner-supplied labels). */
export default function ReferenceLabels() {
  const { serverConfig, projects, projectId, user } = useApp();
  const [taskId, setTaskId] = useState('stance');
  const [itemType, setItemType] = useState('comment');
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [csv, setCsv] = useState(null);
  const [cols, setCols] = useState({ id: 0, label: 1, article: -1 });
  const [mapping, setMapping] = useState({});
  const [meta, setMeta] = useState({ labelSource: 'partner', annotator: '', guideVersion: 'v1', projectId: projectId || '' });
  const [busy, setBusy] = useState(false);

  const task = serverConfig?.tasks.find((t) => t.id === taskId);

  const load = () => {
    setError(null);
    api.referenceLabels({ task: taskId, itemType }).then(setRows).catch((e) => setError(e.message));
  };
  useEffect(load, [taskId, itemType]);

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setMessage(null);
    const parsed = parseCSV(await file.text());
    if (parsed.length < 2) { setError('The CSV needs a header row and at least one data row.'); return; }
    const header = parsed[0];
    setCsv({ name: file.name, header, data: parsed.slice(1) });
    setCols({
      id: Math.max(0, guess(header, ['item_id', 'id', 'comment_id', 'article_id', 'unit_id'])),
      label: Math.max(0, guess(header, ['label', 'stance', 'sentiment', 'category', 'stakeholder', 'code', 'topic'])),
      article: guess(header, ['article_id']),
    });
    setMapping({});
    setMeta((m) => ({ ...m, annotator: m.annotator || file.name.replace(/\.csv$/i, '') }));
  };

  const rawLabels = useMemo(() => (csv ? [...new Set(csv.data.map((r) => String(r[cols.label] ?? '').trim()).filter(Boolean))].sort() : []), [csv, cols.label]);

  useEffect(() => {
    if (!task?.labels) return;
    setMapping((m) => {
      const next = { ...m };
      for (const raw of rawLabels) {
        if (next[raw] !== undefined) continue;
        const lower = raw.toLowerCase();
        next[raw] = task.labels.find((l) => l === lower || l.startsWith(lower) || lower.startsWith(l)) || '';
      }
      return next;
    });
  }, [rawLabels, task]);

  const unmapped = rawLabels.filter((r) => task?.labels && !mapping[r]);

  const importCsv = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const labels = csv.data.map((r) => ({
        itemId: r[cols.id]?.trim(),
        label: r[cols.label]?.trim(),
        articleId: cols.article >= 0 ? r[cols.article]?.trim() : undefined,
      })).filter((l) => l.label);
      const useMapping = task?.labels ? Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)) : null;
      let saved = 0;
      for (let i = 0; i < labels.length; i += 5000) {
        const out = await api.saveReferenceLabels({
          task: taskId, itemType, labels: labels.slice(i, i + 5000), mapping: useMapping,
          labelSource: meta.labelSource, annotator: meta.annotator, guideVersion: meta.guideVersion, projectId: meta.projectId || undefined,
        });
        saved += out.length;
      }
      setMessage(`Imported ${saved} reference label(s).`);
      setCsv(null);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r) => {
    try {
      await api.deleteReferenceLabel(r.id);
      setRows(rows.filter((x) => x.id !== r.id));
    } catch (e) {
      setError(e.message);
    }
  };

  // Agreement between every pair of annotator sets (source/annotator/guide version) on shared items.
  const coders = useMemo(() => {
    const groups = new Map();
    for (const r of rows) {
      const key = `${r.label_source}: ${r.annotator || 'unknown'} (${r.guide_version})`;
      if (!groups.has(key)) groups.set(key, new Map());
      groups.get(key).set(r.item_id, r.label);
    }
    return groups;
  }, [rows]);
  const agreement = useMemo(() => {
    const keys = [...coders.keys()];
    if (keys.length < 2) return [];
    const ids = [...new Set(rows.map((r) => r.item_id))];
    const methods = keys.map((k) => ({ methodName: k, results: ids.map((id) => (coders.get(k).has(id) ? { label: coders.get(k).get(id) } : null)) }));
    return pairwiseAgreement(methods).filter((p) => p.n > 0);
  }, [coders, rows]);

  const exportLabels = (format) => {
    const header = ['id', 'task', 'item_type', 'item_id', 'article_id', 'label', 'original_label', 'label_source', 'annotator', 'guide_version', 'project_id', 'updated_at'];
    exportRows(format, `reference-${taskId}-${itemType}`, header, rows.map((r) => header.map((h) => r[h])), { task: taskId, itemType });
  };

  if (!serverConfig) return <><h1>Reference labels</h1><p className="muted">Connecting to the analysis server…</p></>;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Reference labels</h1>
          <p className="muted">
            The human reference sample (200–300 units recommended) is used to evaluate traditional and AI methods. Team members code items on any results page;
            partner labels can be imported here and mapped to this project’s label set. Original partner labels are kept alongside the mapped label.
          </p>
        </div>
      </div>

      <div className="panel filters">
        <label className="field">Task
          <select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
            {serverConfig.tasks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label className="field">Unit
          <select value={itemType} onChange={(e) => setItemType(e.target.value)}>
            <option value="article">Articles</option>
            <option value="comment">Comments</option>
          </select>
        </label>
        {task?.labels && <div className="field">Label set<div className="small">{task.labels.join(' · ')}</div></div>}
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Import labels from CSV</h3>
        <p className="muted small">One row per unit with at least an item id ({itemType} id in Supabase) and a label column.</p>
        <input type="file" accept=".csv,text/csv" onChange={onFile} />
        {csv && (
          <>
            <p className="small">{csv.name}: {csv.data.length} row(s)</p>
            <div className="filters">
              {[['id', `${itemType} id column`], ['label', 'Label column'], ['article', 'Article id column (optional)']].map(([k, name]) => (
                <label key={k} className="field">{name}
                  <select value={cols[k]} onChange={(e) => setCols({ ...cols, [k]: Number(e.target.value) })}>
                    {k === 'article' && <option value={-1}>—</option>}
                    {csv.header.map((h, i) => <option key={i} value={i}>{h || `column ${i + 1}`}</option>)}
                  </select>
                </label>
              ))}
              <label className="field">Label source
                <select value={meta.labelSource} onChange={(e) => setMeta({ ...meta, labelSource: e.target.value })}>
                  <option value="partner">Partner</option>
                  <option value="team">Team</option>
                </select>
              </label>
              <label className="field">Annotator / partner name<input type="text" value={meta.annotator} onChange={(e) => setMeta({ ...meta, annotator: e.target.value })} placeholder={user?.email} /></label>
              <label className="field">Coding guide version<input type="text" value={meta.guideVersion} onChange={(e) => setMeta({ ...meta, guideVersion: e.target.value })} /></label>
              <label className="field">Project
                <select value={meta.projectId} onChange={(e) => setMeta({ ...meta, projectId: e.target.value })}>
                  <option value="">—</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
            </div>
            {task?.labels && (
              <>
                <h4>Map labels to this project’s {task.name} labels</h4>
                <table style={{ width: 'auto' }}>
                  <thead><tr><th>Label in file</th><th className="num">Rows</th><th>Maps to</th></tr></thead>
                  <tbody>
                    {rawLabels.map((raw) => (
                      <tr key={raw}>
                        <td className="mono">{raw}</td>
                        <td className="num">{csv.data.filter((r) => String(r[cols.label] ?? '').trim() === raw).length}</td>
                        <td>
                          <select value={mapping[raw] || ''} onChange={(e) => setMapping({ ...mapping, [raw]: e.target.value })}>
                            <option value="">— not mapped (row rejected) —</option>
                            {task.labels.map((l) => <option key={l} value={l}>{l}</option>)}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {unmapped.length > 0 && <div className="alert warn" style={{ marginTop: '0.5rem' }}>Unmapped labels: {unmapped.join(', ')}. Map them or remove those rows; the import is rejected otherwise.</div>}
              </>
            )}
            <div className="row" style={{ marginTop: '0.75rem' }}>
              <button className="primary" disabled={busy || unmapped.length > 0} onClick={importCsv}>{busy ? 'Importing…' : `Import ${csv.data.length} label(s)`}</button>
              <button onClick={() => setCsv(null)}>Cancel</button>
            </div>
          </>
        )}
        {message && <div className="alert ok" style={{ marginTop: '0.75rem' }}>{message}</div>}
      </div>
      {error && <div className="alert error">{error}</div>}

      {agreement.length > 0 && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Agreement between coders</h3>
          <table>
            <thead><tr><th>Coder A</th><th>Coder B</th><th className="num">Shared items</th><th className="num">% agreement</th><th className="num">Cohen’s κ</th></tr></thead>
            <tbody>
              {agreement.map((p) => <tr key={`${p.a}|${p.b}`}><td>{p.a}</td><td>{p.b}</td><td className="num">{p.n}</td><td className="num">{pct(p.agreement, 1)}</td><td className="num">{num(p.kappa)}</td></tr>)}
            </tbody>
          </table>
          <p className="muted small">Check human agreement before using the sample as ground truth; low κ usually means the coding guide needs clarification.</p>
        </div>
      )}

      <div className="row" style={{ margin: '1rem 0 0.5rem' }}>
        <h3 style={{ margin: 0 }}>Stored labels</h3>
        <span className="muted">{rows.length} label(s) · {coders.size} coder set(s)</span>
        <span className="spacer" />
        {['csv', 'json', 'xml'].map((f) => <button key={f} disabled={!rows.length} onClick={() => exportLabels(f)}>{f.toUpperCase()}</button>)}
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>{itemType} id</th><th>Label</th><th>Original label</th><th>Source</th><th>Annotator</th><th>Guide</th><th>Updated</th><th /></tr></thead>
          <tbody>
            {!rows.length && <tr><td colSpan={8} className="muted">No reference labels for this task yet.</td></tr>}
            {rows.slice(0, 1000).map((r) => (
              <tr key={r.id}>
                <td>{r.item_id}</td>
                <td><span className={`tag ${r.label}`}>{r.label}</span></td>
                <td className="mono small">{r.original_label || ''}</td>
                <td>{r.label_source}</td>
                <td className="small">{r.annotator}</td>
                <td className="small">{r.guide_version}</td>
                <td className="small muted">{String(r.updated_at || r.created_at).slice(0, 10)}</td>
                <td><button className="danger" onClick={() => remove(r)}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > 1000 && <p className="muted small">Showing the first 1,000 rows; export to see all.</p>}
      </div>
    </>
  );
}
