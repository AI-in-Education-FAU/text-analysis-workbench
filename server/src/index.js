import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { config, providers } from './config.js';
import { createJob, getJob, retryJob, retrySavedRun } from './analyze.js';
import { requireUser } from './auth.js';
import { concordance, keywords, summarize } from './corpus.js';
import { createProject, deleteProject, getProject, listProjects, updateProject } from './projects.js';
import { describeTasks, TASKS } from './registry.js';
import {
  assertRunAccess, decisionHistory, deleteReferenceLabel, listReferenceLabels, recordDecision,
  runVisibility, saveReferenceLabels, searchResults, summarizeResults,
} from './results.js';
import { db, check, supabaseConfigured } from './supabase.js';
import { loadItems } from './data.js';
import { truncate } from './text.js';

const app = express();
app.use(cors({ origin: config.corsOrigin.split(',').map((s) => s.trim()) }));
app.use(express.json({ limit: '5mb' }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

app.get('/api/config', (_req, res) => {
  res.json({
    supabase: supabaseConfigured(),
    openai: providers.openai(),
    huggingface: providers.huggingface(),
    openaiModel: config.openaiModel,
    maxItemsPerRun: config.maxItemsPerRun,
    authRequired: !config.authDisabled,
    tasks: describeTasks(),
  });
});

app.use('/api', requireUser);

// Projects (FR-2, FR-3, FR-7, FR-30)
app.get('/api/projects', wrap(async (req, res) => res.json(await listProjects(req.user))));
app.post('/api/projects', wrap(async (req, res) => res.status(201).json(await createProject(req.body, req.user))));
app.get('/api/projects/:id', wrap(async (req, res) => res.json(await getProject(req.params.id, req.user))));
app.put('/api/projects/:id', wrap(async (req, res) => res.json(await updateProject(req.params.id, req.body, req.user))));
app.delete('/api/projects/:id', wrap(async (req, res) => {
  await deleteProject(req.params.id, req.user);
  res.json({ ok: true });
}));

// Analysis jobs (FR-14, FR-15, FR-16)
app.post('/api/analyze', wrap(async (req, res) => {
  const job = await createJob(req.body, req.user);
  res.status(202).json({ jobId: job.id });
}));

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id, req.user);
  if (!job) return res.status(404).json({ error: 'Job not found (jobs are kept in memory for 2 hours)' });
  res.json(job);
});

app.post('/api/jobs/:id/retry', wrap(async (req, res) => res.status(202).json(await retryJob(req.params.id, req.user))));

// Corpus tools
app.post('/api/corpus/keywords', wrap(async (req, res) => res.json(await keywords(req.body || {}))));
app.post('/api/corpus/concordance', wrap(async (req, res) => res.json(await concordance(req.body || {}))));
app.post('/api/corpus/summarize', wrap(async (req, res) => {
  if (!providers.openai()) return res.status(400).json({ error: 'OPENAI_API_KEY is not configured on the server' });
  res.json(await summarize(req.body || {}));
}));

// Saved runs (FR-31)
app.get('/api/runs', wrap(async (req, res) => {
  let q = db().from('analysis_runs').select('*').order('created_at', { ascending: false }).limit(Math.min(Number(req.query.limit) || 200, 1000));
  if (req.query.task) q = q.eq('task', req.query.task);
  if (req.query.projectId) q = q.eq('project_id', req.query.projectId);
  const vis = await runVisibility(req.user);
  if (vis) q = q.or(vis);
  res.json(check(await q));
}));

function resultFromRow(task, r) {
  if (r.status === 'failed') return { error: r.error || 'failed', flags: r.flags, rowId: r.id };
  if (r.status === 'ineligible') return { status: 'ineligible', reason: r.error, flags: r.flags, rowId: r.id };
  return {
    label: r[task.labelColumn],
    confidence: r.confidence,
    score: r.score,
    rationale: r.rationale,
    evidence: r.evidence,
    keywords: r.keywords,
    flags: r.flags || [],
    targetType: r.target_type,
    targetId: r.target_id,
    rowId: r.id,
  };
}

app.get('/api/runs/:id', wrap(async (req, res) => {
  const run = await assertRunAccess(req.params.id, req.user);
  const task = TASKS[run.task];
  if (!task) return res.status(400).json({ error: `Unknown task "${run.task}"` });
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const page = check(await db().from(task.table).select('*').eq('run_id', run.id).order('id').range(from, from + 999));
    rows.push(...page);
    if (page.length < 1000) break;
  }
  const idOf = (r) => (run.target_type === 'comments' ? r.comment_id : r.article_id);
  const items = await loadItems(run.target_type, rows.map(idOf));
  const byId = new Map(items.map((it) => [it.id, it]));
  const kept = rows.filter((r) => byId.has(idOf(r)));
  res.json({
    run,
    result: {
      task: run.task,
      target: run.target_type,
      projectId: run.project_id,
      options: run.options,
      status: run.status,
      items: kept.map((r) => {
        const it = byId.get(idOf(r));
        return { id: it.id, type: it.type, article_id: it.article_id, parent_comment_id: it.parent_comment_id, title: it.title, snippet: truncate(it.text, 300), date: it.date, source: it.source, source_type: it.source_type };
      }),
      methods: [{
        methodId: run.method,
        methodName: run.method_name || run.method,
        version: run.method_version,
        status: run.status,
        error: run.error,
        runId: run.id,
        summary: run.summary,
        results: kept.map((r) => resultFromRow(task, r)),
      }],
      agreement: [],
    },
  });
}));

app.post('/api/runs/:id/retry', wrap(async (req, res) => {
  await assertRunAccess(req.params.id, req.user);
  res.status(202).json(await retrySavedRun(req.params.id, req.user));
}));

app.delete('/api/runs/:id', wrap(async (req, res) => {
  const run = await assertRunAccess(req.params.id, req.user);
  check(await db().from('validation_decisions').delete().eq('run_id', run.id));
  check(await db().from(TASKS[run.task].table).delete().eq('run_id', run.id));
  check(await db().from('analysis_runs').delete().eq('id', run.id));
  res.json({ ok: true });
}));

// Results search, charts and researcher validation (FR-24, FR-25, FR-28, FR-29)
app.get('/api/results', wrap(async (req, res) => res.json(await searchResults(req.query, req.user))));
app.get('/api/results/summary', wrap(async (req, res) => res.json(await summarizeResults(req.query, req.user))));
app.post('/api/validations', wrap(async (req, res) => res.status(201).json(await recordDecision(req.body || {}, req.user))));
app.get('/api/validations', wrap(async (req, res) => res.json(await decisionHistory(req.query.task, req.query.resultId, req.user))));

// Human reference sample (FR-23)
app.get('/api/reference-labels', wrap(async (req, res) => res.json(await listReferenceLabels(req.query))));
app.post('/api/reference-labels', wrap(async (req, res) => res.status(201).json(await saveReferenceLabels(req.body || {}, req.user))));
app.delete('/api/reference-labels/:id', wrap(async (req, res) => {
  await deleteReferenceLabel(req.params.id, req.user);
  res.json({ ok: true });
}));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// In production, serve the built React app (client/dist) from the same origin as the API.
const clientDist = config.clientDist || fileURLToPath(new URL('../../client/dist', import.meta.url));
if (existsSync(path.join(clientDist, 'index.html'))) {
  app.use(express.static(clientDist));
  app.get('/{*splat}', (req, res, next) => (path.extname(req.path) ? next() : res.sendFile(path.join(clientDist, 'index.html'))));
}

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Server error', ...(err.fields ? { fields: err.fields } : {}) });
});

app.listen(config.port, () => {
  console.log(`Analysis API listening on http://localhost:${config.port}`);
  console.log(`Supabase: ${supabaseConfigured() ? 'configured' : 'NOT configured'} | OpenAI: ${providers.openai() ? 'on' : 'off'} | Hugging Face: ${providers.huggingface() ? 'on' : 'off'} | Auth: ${config.authDisabled ? 'DISABLED' : 'required'}`);
});
