import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../AppContext.jsx';
import { api } from '../utils/api';
import { getCounts } from '../utils/data';

const fmt = (n) => (n === null || n === undefined ? '…' : n.toLocaleString());

export default function Dashboard() {
  const { serverConfig, refreshConfig } = useApp();
  const [counts, setCounts] = useState(null);
  const [countError, setCountError] = useState(null);
  const [runs, setRuns] = useState(null);
  const [runsError, setRunsError] = useState(null);

  useEffect(() => {
    getCounts().then(setCounts).catch((e) => setCountError(e.message));
    api.runs().then((r) => setRuns(r.slice(0, 8))).catch((e) => setRunsError(e.message));
  }, []);

  const status = (ok, label, hint) => (
    <tr>
      <td>{label}</td>
      <td>{ok ? <span className="ok-text">● connected</span> : <span className="bad-text">● not configured</span>}</td>
      <td className="muted small">{hint}</td>
    </tr>
  );

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">Query articles and comments from Supabase, run several NLP methods side by side, validate them against human coding, and save the results.</p>
        </div>
        <Link to="/explore"><button className="primary">Start: explore data →</button></Link>
      </div>

      {countError && <div className="alert error">Could not read Supabase: {countError}</div>}
      <div className="grid cols-3">
        <div className="stat"><div className="value">{fmt(counts?.articles)}</div><div className="label">Articles</div></div>
        <div className="stat"><div className="value">{fmt(counts?.relevant)}</div><div className="label">Relevant articles</div></div>
        <div className="stat"><div className="value">{fmt(counts?.comments)}</div><div className="label">Comments</div></div>
        <div className="stat">
          <div className="value">{serverConfig ? serverConfig.tasks.reduce((s, t) => s + t.methods.filter((m) => m.available).length, 0) : '…'}</div>
          <div className="label">Methods available</div>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: '1rem' }}>
        <div className="panel">
          <div className="row"><h3 style={{ margin: 0 }}>Services</h3><span className="spacer" /><button onClick={refreshConfig}>Refresh</button></div>
          <table>
            <tbody>
              {status(!countError, 'Supabase (browser)', 'client/.env publishable key')}
              {status(serverConfig?.supabase, 'Supabase (server)', 'server/.env service-role key — needed to load text & save results')}
              {status(serverConfig?.openai, 'OpenAI', `server/.env OPENAI_API_KEY${serverConfig?.openai ? ` · default model ${serverConfig.openaiModel}` : ''}`)}
              {status(serverConfig?.huggingface, 'Hugging Face', 'server/.env HF_TOKEN')}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Workflow</h3>
          <ol className="muted" style={{ paddingLeft: '1.2rem', lineHeight: 1.7 }}>
            <li><Link to="/projects">Projects</Link> — save keywords, sources, date range and analyses for a study.</li>
            <li><Link to="/explore">Explore</Link> — filter articles or comments and select a sample.</li>
            <li><Link to="/corpus">Corpus tools</Link> — keywords, concordance and an AI overview to understand the data.</li>
            <li><Link to="/analyze">Analyze</Link> — choose a task and compare several methods on the same items.</li>
            <li><Link to="/reference">Reference labels</Link> — import or code a 200–300 item human sample to measure accuracy / F1 against baselines.</li>
            <li><Link to="/review">Review &amp; validate</Link> — check flagged results, approve or correct labels, and export CSV/JSON/XML.</li>
          </ol>
        </div>
      </div>

      <h2>Recent saved runs</h2>
      {runsError && <div className="alert warn">{runsError}. Did you run <span className="mono">supabase/migrations/001_analysis_tables.sql</span>?</div>}
      {runs && !runs.length && <p className="muted">No saved runs yet.</p>}
      {runs?.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Task</th><th>Method</th><th>Target</th><th className="num">Items</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td><Link to={`/runs/${r.id}`}>{new Date(r.created_at).toLocaleString()}</Link></td>
                  <td>{r.task}</td>
                  <td>{r.method_name || r.method}</td>
                  <td>{r.target_type}</td>
                  <td className="num">{r.item_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
