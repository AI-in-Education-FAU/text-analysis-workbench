import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../AppContext.jsx';
import ResultsView from '../components/ResultsView.jsx';
import { api, pollJob } from '../utils/api';

const DEFAULT_OPTIONS = {
  target: '',
  targetKeywords: '',
  numTopics: 5,
  iterations: 200,
  seed: 42,
  labels: '',
  codebookName: '',
  codebook: '',
  hypothesisTemplate: 'This text is about {}.',
  instructions: '',
  openaiModel: '',
  confidenceThreshold: '',
};

const KIND_LABEL = { lexicon: 'lexicon', statistical: 'statistical', transformer: 'transformer', llm: 'LLM' };

export default function Analyze() {
  const { selection, serverConfig, activeProject } = useApp();
  const [taskId, setTaskId] = useState('sentiment');
  const [chosen, setChosen] = useState({});
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [save, setSave] = useState(true);
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const stopPoll = useRef(() => {});
  const defaultThreshold = activeProject?.config?.confidenceThreshold ?? 0.6;

  const task = serverConfig?.tasks.find((t) => t.id === taskId);
  const selectedMethods = useMemo(() => (task ? task.methods.filter((m) => chosen[`${taskId}:${m.id}`]) : []), [task, chosen, taskId]);
  const usesOpenAI = selectedMethods.some((m) => m.provider === 'openai');
  const usesHF = selectedMethods.some((m) => m.provider === 'huggingface');
  const usesLLMorNLI = usesOpenAI || usesHF;

  useEffect(() => () => stopPoll.current(), []);

  useEffect(() => {
    if (!task) return;
    const anyChosen = task.methods.some((m) => chosen[`${taskId}:${m.id}`] !== undefined);
    if (!anyChosen) {
      const firstLocal = task.methods.find((m) => m.available && !m.needsLabels && !m.provider) || task.methods.find((m) => m.available);
      if (firstLocal) setChosen((c) => ({ ...c, [`${taskId}:${firstLocal.id}`]: true }));
    }
  }, [task, taskId, chosen]);

  const set = (k) => (e) => setOptions({ ...options, [k]: e.target.type === 'number' ? Number(e.target.value) : e.target.value });
  const toggle = (m) => m.available && setChosen({ ...chosen, [`${taskId}:${m.id}`]: !chosen[`${taskId}:${m.id}`] });

  const validation = (() => {
    if (!selection.ids.length) return 'Select items on the Explore page first.';
    if (!selectedMethods.length) return 'Choose at least one method.';
    if (taskId === 'stance' && selection.target !== 'comments') return 'Conversational stance applies to comments only — select comments on the Explore page.';
    if (taskId === 'target_stance' && !options.target.trim()) return 'Enter the stance target / proposition.';
    if (taskId === 'codebook' && options.codebook.split('\n').filter((l) => l.trim()).length < 2) return 'Enter at least 2 codebook labels.';
    if (taskId === 'topics' && selectedMethods.some((m) => m.needsLabels) && options.labels.split(/[,\n]/).filter((l) => l.trim()).length < 2) {
      return 'Zero-shot topic classification needs at least 2 topic labels.';
    }
    return null;
  })();

  const run = async () => {
    setError(null);
    setJob(null);
    stopPoll.current();
    const opts = { ...options, confidenceThreshold: options.confidenceThreshold === '' ? defaultThreshold : Number(options.confidenceThreshold) };
    if (!opts.openaiModel) delete opts.openaiModel;
    try {
      const { jobId } = await api.analyze({
        task: taskId,
        methods: selectedMethods.map((m) => m.id),
        target: selection.target,
        ids: selection.ids,
        options: opts,
        save,
        projectId: activeProject?.id || undefined,
      });
      setJob({ id: jobId, status: 'queued', progress: { done: 0, total: 1, stage: 'Queued' } });
      stopPoll.current = pollJob(jobId, setJob, (e) => setError(e.message));
    } catch (e) {
      setError(e.message);
    }
  };

  const retryFailed = async () => {
    setError(null);
    try {
      const j = await api.retryJob(job.id);
      setJob({ ...job, ...j, result: job.result });
      stopPoll.current = pollJob(job.id, setJob, (e) => setError(e.message));
    } catch (e) {
      setError(e.message);
    }
  };

  if (!serverConfig) {
    return <><h1>Analyze</h1><p className="muted">Connecting to the analysis server…</p></>;
  }

  const running = job && (job.status === 'queued' || job.status === 'running');
  const percent = job ? Math.round((100 * job.progress.done) / Math.max(1, job.progress.total)) : 0;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Analyze</h1>
          <p className="muted">Pick a task, run one or more methods on the same items, then compare and validate them.</p>
        </div>
      </div>

      <div className={`alert ${selection.ids.length ? 'info' : 'warn'}`}>
        {selection.ids.length ? (
          <>Analyzing <strong>{selection.ids.length} {selection.target}</strong>{selection.description ? ` (${selection.description})` : ''}. <Link to="/explore">Change selection</Link></>
        ) : (
          <>No items selected. <Link to="/explore">Go to Explore</Link> to choose articles or comments.</>
        )}
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>1. Task</h3>
        <div className="task-cards">
          {serverConfig.tasks.map((t) => (
            <button key={t.id} className={`task-card ${t.id === taskId ? 'active' : ''}`} onClick={() => setTaskId(t.id)}>
              <strong>{t.name}</strong>
              <span className="muted small">{t.question}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>2. Methods <span className="muted small">(select several to compare)</span></h3>
        <div className="method-list">
          {task.methods.map((m) => {
            const checked = Boolean(chosen[`${taskId}:${m.id}`]);
            return (
              <label key={m.id} className={`method ${checked ? 'checked' : ''} ${m.available ? '' : 'disabled'}`}>
                <input type="checkbox" checked={checked} disabled={!m.available} onChange={() => toggle(m)} />
                <div>
                  <strong>{m.name}</strong> <span className="tag kind">{KIND_LABEL[m.kind] || m.kind}</span>{' '}
                  {m.baseline && <span className="tag baseline" title="Traditional NLP baseline to compare AI methods against (FR-23)">baseline</span>}{' '}
                  {m.provider && <span className="tag">{m.provider}</span>}
                  {!m.available && <span className="tag err">needs {m.provider} key</span>}
                  <p>{m.description}</p>
                </div>
              </label>
            );
          })}
        </div>
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>3. Options</h3>
        <div className="filters">
          {taskId === 'stance' && (
            <p className="muted small" style={{ gridColumn: '1 / -1', margin: 0 }}>
              Each comment is labelled <em>support / oppose / question / neutral</em> toward what it responds to: the parent comment for replies,
              or the article for top-level comments. Articles are not eligible and would be reported as <em>ineligible</em>.
            </p>
          )}
          {taskId === 'target_stance' && (
            <>
              <label className="field" style={{ gridColumn: 'span 2' }}>Target / proposition *
                <input type="text" value={options.target} onChange={set('target')} placeholder='e.g. "the proposed carbon tax"' />
              </label>
              <label className="field" style={{ gridColumn: 'span 2' }}>Extra target keywords (lexicon method, comma-separated)
                <input type="text" value={options.targetKeywords} onChange={set('targetKeywords')} placeholder="carbon pricing, emissions levy" />
              </label>
            </>
          )}
          {taskId === 'topics' && (
            <>
              <label className="field">Number of topics<input type="number" min={2} max={50} value={options.numTopics} onChange={set('numTopics')} /></label>
              <label className="field">Iterations (LDA/NMF)<input type="number" min={20} max={2000} value={options.iterations} onChange={set('iterations')} /></label>
              <label className="field">Random seed<input type="number" value={options.seed} onChange={set('seed')} /></label>
              <label className="field" style={{ gridColumn: '1 / -1' }}>Topic labels (zero-shot / OpenAI; comma or one per line — leave empty for OpenAI to discover topics)
                <textarea value={options.labels} onChange={set('labels')} placeholder={'economy\nhealth care\nimmigration'} />
              </label>
            </>
          )}
          {taskId === 'codebook' && (
            <>
              <label className="field">Codebook name<input type="text" value={options.codebookName} onChange={set('codebookName')} placeholder="e.g. frames-v1" /></label>
              <label className="field" style={{ gridColumn: 'span 2' }}>Zero-shot hypothesis template<input type="text" value={options.hypothesisTemplate} onChange={set('hypothesisTemplate')} /></label>
              <label className="field" style={{ gridColumn: '1 / -1' }}>Codebook * — one label per line, optionally “label: definition”
                <textarea
                  value={options.codebook}
                  onChange={set('codebook')}
                  style={{ minHeight: 140 }}
                  placeholder={'economic: costs, jobs, prices or economic consequences\nfairness: equality, who benefits or is harmed\nsecurity: safety, crime or national security\nother: none of the above'}
                />
              </label>
            </>
          )}
          {usesOpenAI && (
            <label className="field">OpenAI model<input type="text" value={options.openaiModel} onChange={set('openaiModel')} placeholder={serverConfig.openaiModel} /></label>
          )}
          {usesOpenAI && (
            <label className="field" style={{ gridColumn: '1 / -1' }}>Extra instructions for the LLM (codebook notes, edge cases)
              <textarea value={options.instructions} onChange={set('instructions')} placeholder="e.g. Sarcastic praise counts as negative. Ignore quoted opinions of officials." />
            </label>
          )}
          <label className="field">Flag results with confidence below
            <input type="number" min={0} max={1} step={0.05} value={options.confidenceThreshold} onChange={set('confidenceThreshold')} placeholder={String(defaultThreshold)} />
          </label>
        </div>
      </div>

      <div className="panel">
        <div className="row">
          <label className="check"><input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> Save results to Supabase</label>
          {activeProject && <span className="muted small">Project: <strong>{activeProject.name}</strong></span>}
          <span className="spacer" />
          {validation && <span className="muted">{validation}</span>}
          <button className="primary" onClick={run} disabled={Boolean(validation) || running}>{running ? 'Running…' : 'Run analysis'}</button>
        </div>
        {usesLLMorNLI && selection.ids.length > 0 && (
          <p className="muted small" style={{ marginBottom: 0 }}>
            {usesOpenAI && `OpenAI: about ${Math.ceil(selection.ids.length / 8)} API request(s) per OpenAI method — this costs money. `}
            {usesHF && `Hugging Face: one or more requests per item; free-tier rate limits may slow large runs. `}
            Texts are sent to the provider; don’t use external APIs for data you may not share.
          </p>
        )}
      </div>

      {error && <div className="alert error">{error}</div>}
      {job && job.status !== 'done' && (
        <div className="panel">
          <div className="row"><strong>{job.progress.stage}</strong><span className="spacer" /><span className="muted">{job.progress.done}/{job.progress.total}</span></div>
          <div className="progress" style={{ marginTop: '0.5rem' }}><div style={{ width: `${percent}%` }} /></div>
          {job.status === 'error' && <div className="alert error" style={{ marginTop: '0.75rem', marginBottom: 0 }}>{job.error}</div>}
        </div>
      )}
      {job?.status === 'done' && job.result && job.result.status !== 'completed' && (
        <div className={`alert ${job.result.status === 'failed' ? 'error' : 'warn'} row`}>
          <span>
            Analysis {job.result.status === 'failed' ? 'failed' : 'partially completed'}:{' '}
            {job.result.methods
              .filter((m) => m.status !== 'completed')
              .map((m) => `${m.methodName}: ${m.summary?.errors ?? 0} failed item(s)${m.error ? ` (${m.error})` : ''}`)
              .join('; ')}
            . Completed results are kept.
          </span>
          <span className="spacer" />
          {job.result.methods.some((m) => m.summary?.errors) && <button className="primary" onClick={retryFailed}>Retry failed items</button>}
        </div>
      )}
      {job?.status === 'done' && job.result && (
        <ResultsView
          result={job.result}
          taskLabels={serverConfig.tasks.find((t) => t.id === job.result.task)?.labels}
        />
      )}
    </>
  );
}
