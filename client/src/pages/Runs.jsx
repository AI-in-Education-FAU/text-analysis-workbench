import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../AppContext.jsx';
import { api } from '../utils/api';
import { num, pct } from '../utils/metrics';

export default function Runs() {
  const { serverConfig, projects, projectId } = useApp();
  const [project, setProject] = useState(projectId || '');
  const navigate = useNavigate();
  const [task, setTask] = useState('');
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);
  const [checked, setChecked] = useState([]);

  const load = () => {
    setError(null);
    api.runs({ task, projectId: project }).then(setRuns).catch((e) => setError(e.message));
  };
  useEffect(load, [task, project]);
  const projectName = (id) => projects.find((p) => String(p.id) === String(id))?.name;

  const toggle = (id) => setChecked(checked.includes(id) ? checked.filter((x) => x !== id) : [...checked, id]);
  const chosenRuns = (runs || []).filter((r) => checked.includes(r.id));
  const compatible = chosenRuns.length > 1 && chosenRuns.every((r) => r.task === chosenRuns[0].task && r.target_type === chosenRuns[0].target_type);

  const remove = async (id) => {
    if (!window.confirm('Delete this run and all its saved results?')) return;
    try {
      await api.deleteRun(id);
      setChecked(checked.filter((x) => x !== id));
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Saved runs</h1>
          <p className="muted">Every saved run records its method, options, model and summary. Select runs of the same task to compare them.</p>
        </div>
        <div className="row">
          <select value={task} onChange={(e) => { setTask(e.target.value); setChecked([]); }} style={{ width: 'auto' }}>
            <option value="">All tasks</option>
            {serverConfig?.tasks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select value={project} onChange={(e) => { setProject(e.target.value); setChecked([]); }} style={{ width: 'auto' }}>
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button className="primary" disabled={!compatible} onClick={() => navigate(`/runs/${checked.join(',')}`)}>
            Compare {chosenRuns.length > 1 ? chosenRuns.length : ''} runs
          </button>
        </div>
      </div>
      {chosenRuns.length > 1 && !compatible && <div className="alert warn">Only runs with the same task and target (articles/comments) can be compared.</div>}
      {error && <div className="alert error">{error}. Did you run the SQL files in <span className="mono">supabase/migrations</span>?</div>}
      {runs && !runs.length && <p className="muted">No saved runs yet. Tick “Save results to Supabase” on the Analyze page.</p>}
      {runs?.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th /><th>When</th><th>Task</th><th>Method</th><th>Status</th><th>Project</th><th>Target</th><th className="num">Items</th><th className="num">Failure rate</th><th className="num">Mean conf.</th><th>Settings</th><th /></tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className={checked.includes(r.id) ? 'selected' : ''}>
                  <td><input type="checkbox" checked={checked.includes(r.id)} onChange={() => toggle(r.id)} /></td>
                  <td><Link to={`/runs/${r.id}`}>{new Date(r.created_at).toLocaleString()}</Link></td>
                  <td>{r.task}</td>
                  <td>{r.method_name || r.method}{r.method_version && <div className="muted small mono">{r.method_version}</div>}</td>
                  <td><span className={`tag status-${r.status || 'completed'}`}>{r.status || 'completed'}</span></td>
                  <td className="small">{projectName(r.project_id) || (r.project_id ? `#${r.project_id}` : '?')}</td>
                  <td>{r.target_type}</td>
                  <td className="num">{r.item_count}</td>
                  <td className="num">{pct(r.summary?.failureRate, 1)}</td>
                  <td className="num">{num(r.summary?.meanConfidence)}</td>
                  <td className="small muted">
                    {[r.options?.target && `target: ${r.options.target}`, r.summary?.model, r.options?.codebookName && `codebook: ${r.options.codebookName}`, r.task === 'topics' && r.options?.numTopics && `k=${r.options.numTopics}`]
                      .filter(Boolean).join(' · ')}
                  </td>
                  <td><button className="danger" onClick={() => remove(r.id)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
