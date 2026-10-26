import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../AppContext.jsx';
import ItemModal from '../components/ItemModal.jsx';
import { fetchMatchingIds, getFilterOptions, queryItems } from '../utils/data';
import { pseudonym } from '../utils/metrics';

const PAGE_SIZE = 25;
const EMPTY = { search: '', source: '', source_type: '', keyword: '', from: '', to: '', relevant: 'true', article_id: '', topLevel: '' };

function describe(target, f, project) {
  const parts = [];
  if (project) parts.push(`project: ${project.name}`);
  if (f.search) parts.push(`“${f.search}”`);
  if (f.source) parts.push(f.source);
  if (target === 'articles' && f.source_type) parts.push(f.source_type);
  if (f.keyword) parts.push(`kw:${f.keyword}`);
  if (f.from || f.to) parts.push(`${f.from || '…'} → ${f.to || '…'}`);
  if (target === 'articles' && f.relevant !== 'all') parts.push(f.relevant === 'true' ? 'relevant' : 'not relevant');
  if (target === 'comments' && f.article_id) parts.push(`article #${f.article_id}`);
  return parts.join(', ');
}

export function projectSummary(cfg = {}) {
  const bits = [];
  if (cfg.keywords?.length) bits.push(`keywords: ${cfg.keywords.join(', ')}`);
  if (cfg.topics?.length) bits.push(`topics: ${cfg.topics.join(', ')}`);
  if (cfg.authors?.length) bits.push(`authors: ${cfg.authors.length}`);
  if (cfg.sources?.length) bits.push(`sources: ${cfg.sources.includes('*') ? 'all' : cfg.sources.join(', ')}`);
  if (cfg.sourceTypes?.length) bits.push(`types: ${cfg.sourceTypes.join(', ')}`);
  if (cfg.dateFrom || cfg.dateTo) bits.push(`${cfg.dateFrom || '…'} → ${cfg.dateTo || '…'}`);
  return bits.join(' · ');
}

export default function Explore() {
  const { selection, setSelection, serverConfig, activeProject } = useApp();
  const [useProject, setUseProject] = useState(true);
  const [revealAuthors, setRevealAuthors] = useState(false);
  const navigate = useNavigate();
  const [target, setTarget] = useState(selection.target || 'articles');
  const [draft, setDraft] = useState(EMPTY);
  const [filters, setFilters] = useState(EMPTY);
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [options, setOptions] = useState({ sources: [], sourceTypes: [], keywords: [] });
  const [checked, setChecked] = useState(() => new Set(selection.target === target ? selection.ids : []));
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const max = serverConfig?.maxItemsPerRun ?? 500;

  useEffect(() => { getFilterOptions().then(setOptions).catch(() => {}); }, []);

  const projectScope = useProject && activeProject ? activeProject : null;
  const effective = useMemo(() => ({ ...filters, project: projectScope?.config || null }), [filters, projectScope]);
  useEffect(() => setPage(0), [projectScope]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    queryItems(target, effective, page, PAGE_SIZE)
      .then(({ data, count: n }) => { if (!cancelled) { setRows(data); setCount(n); } })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [target, effective, page]);

  const switchTarget = (t) => {
    setTarget(t);
    setPage(0);
    setChecked(new Set(selection.target === t ? selection.ids : []));
  };

  const apply = (e) => { e?.preventDefault(); setPage(0); setFilters(draft); };
  const reset = () => { setDraft(EMPTY); setFilters(EMPTY); setPage(0); };
  const set = (k) => (e) => setDraft({ ...draft, [k]: e.target.value });

  const toggle = (id) => {
    const next = new Set(checked);
    next.has(id) ? next.delete(id) : next.add(id);
    setChecked(next);
  };
  const pageAllChecked = rows.length > 0 && rows.every((r) => checked.has(r.id));
  const togglePage = () => {
    const next = new Set(checked);
    rows.forEach((r) => (pageAllChecked ? next.delete(r.id) : next.add(r.id)));
    setChecked(next);
  };

  const selectAllMatching = async () => {
    setBusy(true);
    try {
      const ids = await fetchMatchingIds(target, effective, max);
      setChecked(new Set(ids));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const commit = (to) => {
    setSelection({ target, ids: [...checked], description: describe(target, filters, projectScope) || 'manual selection' });
    navigate(to);
  };

  const closeModal = useCallback(() => setOpen(null), []);
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  const tooMany = checked.size > max;

  const columns = useMemo(() => (target === 'articles'
    ? ['Title', 'Author', 'Source', 'Type', 'Keyword', 'Published']
    : ['Comment', 'Article', 'Source', 'Published']), [target]);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Explore data</h1>
          <p className="muted">Query your Supabase tables, read items, and select the sample to analyze.</p>
        </div>
      </div>

      <div className="tabs">
        <button className={target === 'articles' ? 'active' : ''} onClick={() => switchTarget('articles')}>Articles</button>
        <button className={target === 'comments' ? 'active' : ''} onClick={() => switchTarget('comments')}>Comments</button>
      </div>

      {activeProject ? (
        <div className="alert info row">
          <label className="check"><input type="checkbox" checked={useProject} onChange={(e) => setUseProject(e.target.checked)} /> Restrict to project <strong>{activeProject.name}</strong></label>
          <span className="muted small">{projectSummary(activeProject.config)}</span>
        </div>
      ) : (
        <div className="alert info">Tip: create a <Link to="/projects">project</Link> to save search criteria, sources and date range.</div>
      )}

      <form className="panel filters" onSubmit={apply}>
        <label className="field">Search text<input type="search" value={draft.search} onChange={set('search')} placeholder={target === 'articles' ? 'title or content…' : 'comment text…'} /></label>
        <label className="field">Source
          <select value={draft.source} onChange={set('source')}>
            <option value="">All</option>
            {options.sources.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        {target === 'articles' && (
          <label className="field">Source type
            <select value={draft.source_type} onChange={set('source_type')}>
              <option value="">All</option>
              {options.sourceTypes.map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
        )}
        <label className="field">Keyword
          <select value={draft.keyword} onChange={set('keyword')}>
            <option value="">All</option>
            {options.keywords.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <label className="field">From<input type="date" value={draft.from} onChange={set('from')} /></label>
        <label className="field">To<input type="date" value={draft.to} onChange={set('to')} /></label>
        {target === 'articles' ? (
          <label className="field">Relevance
            <select value={draft.relevant} onChange={set('relevant')}>
              <option value="true">Relevant only</option>
              <option value="false">Not relevant</option>
              <option value="all">All</option>
            </select>
          </label>
        ) : (
          <>
            <label className="field">Article ID<input type="number" value={draft.article_id} onChange={set('article_id')} /></label>
            <label className="field">Thread level
              <select value={draft.topLevel} onChange={set('topLevel')}>
                <option value="">All comments</option>
                <option value="true">Top-level only</option>
              </select>
            </label>
          </>
        )}
        <div className="row">
          <button className="primary" type="submit">Apply</button>
          <button type="button" onClick={reset}>Reset</button>
        </div>
      </form>

      <div className="row" style={{ marginBottom: '0.75rem' }}>
        <span><strong>{count.toLocaleString()}</strong> matching {target}</span>
        <span className="muted">· {checked.size} selected</span>
        <button onClick={selectAllMatching} disabled={busy || !count}>{busy ? 'Selecting…' : `Select all matching (max ${max})`}</button>
        <button onClick={() => setChecked(new Set())} disabled={!checked.size}>Clear selection</button>
        {target === 'articles' && <label className="check small"><input type="checkbox" checked={revealAuthors} onChange={(e) => setRevealAuthors(e.target.checked)} /> Reveal author names</label>}
        <span className="spacer" />
        <button onClick={() => commit('/corpus')} disabled={!checked.size}>Corpus tools →</button>
        <button className="primary" onClick={() => commit('/analyze')} disabled={!checked.size || tooMany}>Analyze {checked.size || ''} selected →</button>
      </div>
      {tooMany && <div className="alert warn">The server analyzes at most {max} items per run. Narrow the filters or clear some items (corpus tools allow up to {max * 4}).</div>}
      {error && <div className="alert error">{error}</div>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 32 }}><input type="checkbox" checked={pageAllChecked} onChange={togglePage} /></th>
              <th style={{ width: 60 }}>ID</th>
              {columns.map((c) => <th key={c}>{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={columns.length + 2} className="muted">Loading…</td></tr>}
            {!loading && !rows.length && <tr><td colSpan={columns.length + 2} className="muted">No results.</td></tr>}
            {!loading && rows.map((r) => (
              <tr key={r.id} className={`clickable ${checked.has(r.id) ? 'selected' : ''}`} onClick={() => setOpen(r.id)}>
                <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={checked.has(r.id)} onChange={() => toggle(r.id)} /></td>
                <td className="muted">{r.id}</td>
                {target === 'articles' ? (
                  <>
                    <td><div className="clamp">{r.title || <em className="muted">untitled</em>}</div></td>
                    <td className="small" title={revealAuthors ? '' : 'Pseudonymized (FR-26)'}>{revealAuthors ? r.author || '—' : pseudonym(r.author) || '—'}</td>
                    <td>{r.source}</td>
                    <td>{r.source_type}</td>
                    <td>{r.keyword}</td>
                    <td>{r.published_date}</td>
                  </>
                ) : (
                  <>
                    <td style={{ maxWidth: 480 }}><div className="clamp">{r.text}</div></td>
                    <td><div className="clamp small">#{r.article_id} {r.articles?.title}</div></td>
                    <td>{r.articles?.source}</td>
                    <td>{r.published_date}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="row" style={{ marginTop: '0.75rem' }}>
        <button onClick={() => setPage(0)} disabled={page === 0}>«</button>
        <button onClick={() => setPage(page - 1)} disabled={page === 0}>‹ Prev</button>
        <span className="muted">Page {page + 1} of {pages}</span>
        <button onClick={() => setPage(page + 1)} disabled={page + 1 >= pages}>Next ›</button>
        <button onClick={() => setPage(pages - 1)} disabled={page + 1 >= pages}>»</button>
      </div>

      {open !== null && <ItemModal target={target} id={open} onClose={closeModal} />}
    </>
  );
}
