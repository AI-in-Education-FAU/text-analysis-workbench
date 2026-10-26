import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../AppContext.jsx';
import { api } from '../utils/api';
import { getFilterOptions } from '../utils/data';
import { projectSummary } from './Explore.jsx';

const BLANK = {
  name: '',
  description: '',
  config: { keywords: '', topics: '', authors: '', sources: ['*'], sourceTypes: [], dateFrom: '', dateTo: '', target: 'articles', analyses: [], confidenceThreshold: 0.6 },
};

const toForm = (p) => ({
  name: p.name,
  description: p.description || '',
  config: {
    ...BLANK.config,
    ...p.config,
    keywords: (p.config?.keywords || []).join(', '),
    topics: (p.config?.topics || []).join(', '),
    authors: (p.config?.authors || []).join(', '),
    dateFrom: p.config?.dateFrom || '',
    dateTo: p.config?.dateTo || '',
  },
});

function MultiCheck({ options, value, onChange }) {
  const toggle = (o) => onChange(value.includes(o) ? value.filter((v) => v !== o) : [...value, o]);
  return (
    <div className="multicheck">
      {options.map((o) => (
        <label key={o.value} className="check"><input type="checkbox" checked={value.includes(o.value)} onChange={() => toggle(o.value)} /> {o.label}</label>
      ))}
    </div>
  );
}

/** FR-2/3/7/30: create, edit and select research projects that store search criteria and analysis settings. */
export default function Projects() {
  const { projects, refreshProjects, projectId, setProjectId, serverConfig } = useApp();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(BLANK);
  const [fields, setFields] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState({ sources: [], sourceTypes: [] });

  useEffect(() => { getFilterOptions().then(setOptions).catch(() => {}); }, []);

  const start = (p) => {
    setEditing(p ? p.id : 'new');
    setForm(p ? toForm(p) : BLANK);
    setFields({});
    setError(null);
  };
  const setTop = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const setCfg = (k, v) => setForm({ ...form, config: { ...form.config, [k]: v } });

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const body = { ...form, config: { ...form.config, confidenceThreshold: Number(form.config.confidenceThreshold) } };
      const saved = editing === 'new' ? await api.createProject(body) : await api.updateProject(editing, body);
      await refreshProjects();
      setProjectId(saved.id);
      setEditing(null);
    } catch (err) {
      setError(err.message);
      setFields(err.fields || {});
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p) => {
    if (!window.confirm(`Delete project “${p.name}”? Saved analysis runs are kept but no longer linked to it.`)) return;
    try {
      await api.deleteProject(p.id);
      if (String(projectId) === String(p.id)) setProjectId('');
      await refreshProjects();
    } catch (err) {
      setError(err.message);
    }
  };

  const fieldError = (k) => fields[k] && <span className="bad-text small">{fields[k]}</span>;
  const sourceOptions = [{ value: '*', label: 'All supported sources' }, ...options.sources.map((s) => ({ value: s, label: s }))];
  const taskOptions = (serverConfig?.tasks || []).map((t) => ({ value: t.id, label: t.name }));

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Projects</h1>
          <p className="muted">A project stores your search criteria, data sources, date range and analysis settings so the same scope can be re-used and reported.</p>
        </div>
        <button className="primary" onClick={() => start(null)}>New project</button>
      </div>

      {error && !editing && <div className="alert error">{error}</div>}

      {editing && (
        <form className="panel" onSubmit={save} noValidate>
          <h3 style={{ marginTop: 0 }}>{editing === 'new' ? 'New project' : 'Edit project'}</h3>
          <div className="filters">
            <label className="field" style={{ gridColumn: 'span 2' }}>Name * {fieldError('name')}
              <input type="text" value={form.name} onChange={setTop('name')} maxLength={200} />
            </label>
            <label className="field" style={{ gridColumn: 'span 2' }}>Description
              <input type="text" value={form.description} onChange={setTop('description')} />
            </label>
          </div>

          <h4>Search criteria <span className="muted small">(at least one; comma-separated)</span> {fieldError('criteria')}</h4>
          <div className="filters">
            <label className="field">Keywords<input type="text" value={form.config.keywords} onChange={(e) => setCfg('keywords', e.target.value)} placeholder="chatgpt, ai tutor" /></label>
            <label className="field">Topics<input type="text" value={form.config.topics} onChange={(e) => setCfg('topics', e.target.value)} placeholder="academic integrity, assessment" /></label>
            <label className="field">Authors<input type="text" value={form.config.authors} onChange={(e) => setCfg('authors', e.target.value)} placeholder="names as published" /></label>
          </div>

          <h4>Data sources * {fieldError('sources')}</h4>
          <MultiCheck options={sourceOptions} value={form.config.sources} onChange={(v) => setCfg('sources', v)} />
          {options.sourceTypes.length > 0 && (
            <>
              <h4>Source types <span className="muted small">(optional)</span></h4>
              <MultiCheck options={options.sourceTypes.map((s) => ({ value: s, label: s }))} value={form.config.sourceTypes} onChange={(v) => setCfg('sourceTypes', v)} />
            </>
          )}

          <h4>Date range &amp; analysis</h4>
          <div className="filters">
            <label className="field">From {fieldError('dateFrom')}<input type="date" value={form.config.dateFrom} onChange={(e) => setCfg('dateFrom', e.target.value)} /></label>
            <label className="field">To {fieldError('dateTo')}<input type="date" value={form.config.dateTo} onChange={(e) => setCfg('dateTo', e.target.value)} /></label>
            <label className="field">Default unit of analysis
              <select value={form.config.target} onChange={(e) => setCfg('target', e.target.value)}>
                <option value="articles">Articles</option>
                <option value="comments">Comments</option>
              </select>
            </label>
            <label className="field">Low-confidence threshold {fieldError('confidenceThreshold')}
              <input type="number" min={0} max={1} step={0.05} value={form.config.confidenceThreshold} onChange={(e) => setCfg('confidenceThreshold', e.target.value)} />
            </label>
          </div>
          <h4>Planned analyses</h4>
          <MultiCheck options={taskOptions} value={form.config.analyses} onChange={(v) => setCfg('analyses', v)} />

          {error && <div className="alert error" style={{ marginTop: '1rem' }}>{error}</div>}
          <div className="row" style={{ marginTop: '1rem' }}>
            <button className="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save project'}</button>
            <button type="button" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </form>
      )}

      <div className="table-wrap">
        <table>
          <thead><tr><th /><th>Name</th><th>Scope</th><th>Analyses</th><th>Updated</th><th /></tr></thead>
          <tbody>
            {!projects.length && <tr><td colSpan={6} className="muted">No projects yet.</td></tr>}
            {projects.map((p) => (
              <tr key={p.id} className={String(p.id) === String(projectId) ? 'selected' : ''}>
                <td><input type="radio" name="active" checked={String(p.id) === String(projectId)} onChange={() => setProjectId(p.id)} title="Make active" /></td>
                <td><strong>{p.name}</strong>{p.description && <div className="muted small">{p.description}</div>}</td>
                <td className="small">{projectSummary(p.config)}</td>
                <td className="small">{(p.config?.analyses || []).join(', ') || '—'}</td>
                <td className="small muted">{String(p.updated_at || p.created_at).slice(0, 10)}</td>
                <td className="row" style={{ flexWrap: 'nowrap' }}>
                  <button onClick={() => { setProjectId(p.id); navigate('/explore'); }}>Explore</button>
                  <button onClick={() => start(p)}>Edit</button>
                  <button className="danger" onClick={() => remove(p)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {projectId && <p className="muted small">The active project scopes Explore, is attached to new analysis runs, and is the default filter on the Review page.</p>}
    </>
  );
}
