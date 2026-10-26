import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApp } from '../AppContext.jsx';
import ResultsView from '../components/ResultsView.jsx';
import { api, pollJob } from '../utils/api';

/** Combines several saved runs into one result, keeping only items present in every run. */
function mergeRuns(loaded) {
  const base = loaded[0].result;
  const maps = loaded.map(({ result }) => new Map(result.items.map((it, i) => [it.id, result.methods[0].results[i]])));
  const items = base.items.filter((it) => maps.every((m) => m.has(it.id)));
  const names = new Map();
  const methods = loaded.map(({ run, result }, k) => {
    const m = result.methods[0];
    const baseName = m.methodName;
    const count = (names.get(baseName) || 0) + 1;
    names.set(baseName, count);
    return {
      ...m,
      methodId: `${m.methodId}#${k + 1}`,
      methodName: count > 1 || loaded.filter((l) => l.result.methods[0].methodName === baseName).length > 1
        ? `${baseName} (${new Date(run.created_at).toLocaleDateString()} #${k + 1})`
        : baseName,
      results: items.map((it) => maps[k].get(it.id)),
    };
  });
  return { ...base, items, methods };
}

export default function RunDetail() {
  const { id } = useParams();
  const { serverConfig } = useApp();
  const [loaded, setLoaded] = useState(null);
  const [error, setError] = useState(null);
  const [retryMsg, setRetryMsg] = useState(null);
  const ids = id.split(',').filter(Boolean);

  useEffect(() => {
    setLoaded(null);
    setError(null);
    Promise.all(ids.map((x) => api.run(x))).then(setLoaded).catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (error) return <><Link to="/runs">← Saved runs</Link><div className="alert error" style={{ marginTop: '1rem' }}>{error}</div></>;
  if (!loaded) return <p className="muted">Loading run…</p>;

  const merged = loaded.length === 1 ? loaded[0].result : mergeRuns(loaded);
  const task = serverConfig?.tasks.find((t) => t.id === merged.task);
  const result = {
    ...merged,
    methods: merged.methods.map((m) => {
      const def = task?.methods.find((d) => d.id === String(m.methodId).split('#')[0]);
      return { ...m, kind: def?.kind, baseline: def?.baseline };
    }),
  };
  const failedRuns = loaded.filter(({ run }) => run.status === 'partial' || run.status === 'failed');

  const retry = async (runId) => {
    setRetryMsg(null);
    try {
      const j = await api.retryRun(runId);
      setRetryMsg(`Retrying failed items of run #${runId}…`);
      pollJob(j.id, (job) => {
        if (job.status === 'done') {
          setRetryMsg(`Run #${runId}: ${job.result.fixed} of ${job.result.retried} failed item(s) fixed.`);
          Promise.all(ids.map((x) => api.run(x))).then(setLoaded).catch((e) => setError(e.message));
        } else if (job.status === 'error') setRetryMsg(`Retry failed: ${job.error}`);
      }, (e) => setRetryMsg(e.message));
    } catch (e) {
      setRetryMsg(e.message);
    }
  };

  return (
    <>
      <Link to="/runs">← Saved runs</Link>
      <div className="page-header" style={{ marginTop: '0.5rem' }}>
        <div>
          <h1>{task?.name || result.task}{loaded.length > 1 ? ` — comparing ${loaded.length} runs` : ''}</h1>
          <p className="muted">{result.target} · {loaded.map(({ run }) => new Date(run.created_at).toLocaleString()).join(' | ')}</p>
        </div>
      </div>
      {loaded.length > 1 && <div className="alert info">Showing the {result.items.length} item(s) present in every selected run.</div>}
      {failedRuns.map(({ run }) => (
        <div key={run.id} className="alert warn row">
          <span>Run #{run.id} ({run.method}) is <strong>{run.status}</strong>{run.summary?.errors ? ` — ${run.summary.errors} failed item(s)` : ''}{run.error ? `: ${run.error}` : ''}.</span>
          <span className="spacer" />
          <button className="primary" onClick={() => retry(run.id)}>Retry failed items</button>
        </div>
      ))}
      {retryMsg && <div className="alert info">{retryMsg}</div>}
      <details className="panel">
        <summary>Run settings (for your methods section)</summary>
        {loaded.map(({ run }) => (
          <pre key={run.id} className="small mono" style={{ whiteSpace: 'pre-wrap' }}>
            {JSON.stringify({ id: run.id, task: run.task, method: run.method, version: run.method_version, status: run.status, project: run.project_id, target: run.target_type, created_at: run.created_at, options: run.options, model: run.summary?.model }, null, 2)}
          </pre>
        ))}
      </details>
      <ResultsView result={result} taskLabels={task?.labels} />
    </>
  );
}
