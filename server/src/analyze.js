import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { loadItems, loadStanceTargets } from './data.js';
import { agreement, computeFlags, DEFAULT_THRESHOLD, normalizeResults, statusOf, summarize, umassCoherence } from './evaluation.js';
import { parseCodebook } from './methods/classify.js';
import { parseLabels } from './methods/topics.js';
import { getMethod, isBaseline, TASKS } from './registry.js';
import { db, check } from './supabase.js';
import { clamp, mapLimit, truncate } from './text.js';

export { agreement, summarize };

const jobs = new Map();
const jobState = new Map(); // server-only data needed for retries (items, targets, method objects)
const JOB_TTL_MS = 2 * 60 * 60 * 1000;

function badRequest(msg, status = 400) {
  return Object.assign(new Error(msg), { status });
}

/** Labels a method may return for this task, or null when the task has an open label set. */
function allowedLabels(task, options) {
  if (TASKS[task].labels) return TASKS[task].labels;
  if (task === 'codebook') return parseCodebook(options.codebook).map((c) => c.label);
  if (task === 'topics') {
    const labels = parseLabels(options.labels);
    return labels.length ? labels : null;
  }
  return null;
}

function aggregationRules(task, options) {
  const sharedTopicLabels = task === 'topics' && parseLabels(options.labels).length > 0;
  return {
    threshold: clamp(Number(options.confidenceThreshold ?? DEFAULT_THRESHOLD)),
    comparable: (run) => (task === 'topics' ? sharedTopicLabels && run.kind !== 'statistical' : true),
    confidenceApplies: (run) => !(task === 'topics' && run.kind === 'statistical'),
  };
}

async function assertProjectAccess(projectId, user) {
  if (!projectId) return null;
  const project = check(await db().from('projects').select('id,owner_id').eq('id', projectId).maybeSingle());
  if (!project) throw badRequest('Project not found', 404);
  if (user && project.owner_id !== user.id) throw badRequest('You do not have access to this project', 403);
  return project.id;
}

function validate(body) {
  const { task, methods, target, ids, options = {}, save = false, projectId = null } = body || {};
  if (!TASKS[task]) throw badRequest(`Choose a task: ${Object.keys(TASKS).join(', ')}`);
  if (!['articles', 'comments'].includes(target)) throw badRequest('target must be "articles" or "comments"');
  if (!Array.isArray(methods) || !methods.length) throw badRequest('Choose at least one method');
  if (!Array.isArray(ids) || !ids.length) throw badRequest('No items selected');
  if (ids.length > config.maxItemsPerRun) {
    throw badRequest(`Too many items (${ids.length}). The limit per run is ${config.maxItemsPerRun}.`);
  }
  const threshold = Number(options.confidenceThreshold ?? DEFAULT_THRESHOLD);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw badRequest('Confidence threshold must be between 0 and 1');
  const cleanIds = [...new Set(ids.map(Number).filter(Number.isInteger))];
  const resolved = [...new Set(methods)].map((m) => getMethod(task, m).method);
  allowedLabels(task, options); // throws early on an invalid codebook
  return { task, target, ids: cleanIds, options: { ...options, confidenceThreshold: threshold }, save: Boolean(save), projectId, methods: resolved };
}

/** Runs one method in isolation; a crash becomes failed results instead of aborting the job (FR-16). */
async function runMethod(task, method, items, targets, options, onProgress) {
  const started = Date.now();
  let out;
  try {
    out = await method.run(items, options, { onProgress, targets });
  } catch (e) {
    if (e.status === 400) throw e; // configuration problems (e.g. missing stance target) stop the job
    out = { results: items.map(() => ({ error: e.message || 'Method failed' })), fatal: e.message };
  }
  const labels = task === 'topics' && method.kind === 'statistical' ? null : allowedLabels(task, options);
  const results = normalizeResults(out.results, items.length, labels);
  return { results, extra: out.summary || {}, fatal: out.fatal || null, durationMs: Date.now() - started };
}

function runStatus(results, fatal) {
  const s = summarize(results);
  if (fatal || (s.total - s.ineligible > 0 && s.analyzed === 0)) return 'failed';
  return s.errors ? 'partial' : 'completed';
}

function finalizeRuns(spec, items, methodRuns) {
  computeFlags(methodRuns, aggregationRules(spec.task, spec.options));
  for (const run of methodRuns) {
    run.summary = { ...run.extra, ...summarize(run.results), durationMs: run.durationMs };
    if (spec.task === 'topics' && Array.isArray(run.extra.topics)) {
      const coherence = umassCoherence(items.map((it) => it.text), run.extra.topics);
      run.summary.coherence = coherence;
      const vals = coherence.map((c) => c.coherence).filter(Number.isFinite);
      run.summary.meanCoherence = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
    run.status = runStatus(run.results, run.fatal);
  }
}

function rowFor(spec, method, runId, item, r) {
  const t = TASKS[spec.task];
  const status = statusOf(r);
  const row = {
    article_id: item.article_id,
    comment_id: item.comment_id,
    [t.labelColumn]: status === 'ok' ? r.label : null,
    confidence: status === 'ok' && Number.isFinite(r.confidence) ? clamp(r.confidence) : null,
    method: method.id,
    run_id: runId,
    rationale: r.rationale ? truncate(r.rationale, 500) : null,
    evidence: r.evidence ? truncate(r.evidence, 500) : null,
    status,
    error: r.error ? truncate(r.error, 500) : r.reason || null,
    flags: r.flags || [],
  };
  if (spec.task === 'sentiment') row.score = Number.isFinite(r.score) ? r.score : null;
  if (spec.task === 'stance') { row.target_type = r.targetType || null; row.target_id = r.targetId ?? null; }
  if (spec.task === 'target_stance') row.target = spec.options.target || null;
  if (spec.task === 'topics') row.keywords = r.keywords || null;
  if (t.table === 'label_results') {
    row.task = spec.task;
    row.codebook = spec.task === 'codebook' ? spec.options.codebookName || 'custom' : null;
  }
  if (t.table === 'classification_results') {
    row.classifier = method.id;
    row.classified_at = new Date().toISOString();
  }
  return row;
}

function methodVersion(method, extra) {
  return extra.model || method.version || `${method.id} (built-in)`;
}

async function saveRun(spec, user, method, run, items) {
  const t = TASKS[spec.task];
  const saved = check(
    await db()
      .from('analysis_runs')
      .insert({
        task: spec.task,
        method: method.id,
        method_name: method.name,
        method_version: methodVersion(method, run.extra),
        target_type: spec.target,
        project_id: spec.projectId,
        created_by: user?.id || null,
        status: run.status,
        error: run.fatal,
        duration_ms: run.durationMs,
        options: { ...spec.options, _meta: { node: process.version, savedAt: new Date().toISOString(), baseline: isBaseline(method) } },
        item_count: items.length,
        summary: run.summary,
      })
      .select('id')
      .single(),
  );
  const rows = items.map((item, i) => rowFor(spec, method, saved.id, item, run.results[i]));
  const rowIds = [];
  for (let i = 0; i < rows.length; i += 500) {
    const inserted = check(await db().from(t.table).insert(rows.slice(i, i + 500)).select('id'));
    rowIds.push(...inserted.map((r) => r.id));
  }
  return { runId: saved.id, rowIds };
}

function publicResult(spec, items, methodRuns) {
  const statuses = methodRuns.map((r) => r.status);
  return {
    task: spec.task,
    target: spec.target,
    projectId: spec.projectId,
    options: spec.options,
    status: statuses.every((s) => s === 'failed') ? 'failed' : statuses.every((s) => s === 'completed') ? 'completed' : 'partial',
    items: items.map((it) => ({
      id: it.id,
      type: it.type,
      article_id: it.article_id,
      parent_comment_id: it.parent_comment_id,
      title: it.title,
      snippet: truncate(it.text, 300),
      date: it.date,
      source: it.source,
      source_type: it.source_type,
    })),
    methods: methodRuns.map(({ extra, fatal, ...r }) => ({ ...r, error: fatal })),
    agreement: spec.task === 'topics' && !parseLabels(spec.options.labels).length ? [] : agreement(methodRuns),
  };
}

async function execute(job, spec, user) {
  job.status = 'running';
  job.progress.stage = 'Loading items from Supabase';
  const items = await loadItems(spec.target, spec.ids);
  if (!items.length) throw badRequest('No matching records were found, so the analysis was halted (FR-10).');
  let targets = items.map(() => null);
  if (TASKS[spec.task].needsTargets) {
    job.progress.stage = 'Loading conversation targets';
    targets = await loadStanceTargets(items);
  }
  job.progress.total = items.length * spec.methods.length;

  const methodRuns = [];
  for (let m = 0; m < spec.methods.length; m++) {
    const method = spec.methods[m];
    const base = m * items.length;
    job.progress.stage = `Running ${method.name}`;
    const out = await runMethod(spec.task, method, items, targets, spec.options, (done) => {
      job.progress.done = base + Math.min(done, items.length);
    });
    methodRuns.push({
      methodId: method.id,
      methodName: method.name,
      kind: method.kind,
      baseline: isBaseline(method),
      version: methodVersion(method, out.extra),
      results: out.results,
      extra: out.extra,
      fatal: out.fatal,
      durationMs: out.durationMs,
    });
  }
  finalizeRuns(spec, items, methodRuns);

  if (spec.save) {
    for (let m = 0; m < methodRuns.length; m++) {
      job.progress.stage = `Saving ${methodRuns[m].methodName} results`;
      try {
        Object.assign(methodRuns[m], await saveRun(spec, user, spec.methods[m], methodRuns[m], items));
      } catch (e) {
        methodRuns[m].saveError = `${e.message}. Did you run the SQL migrations in supabase/migrations?`;
      }
    }
  }

  jobState.set(job.id, { spec, user, items, targets, methodRuns });
  job.result = publicResult(spec, items, methodRuns);
  job.progress.done = job.progress.total;
  job.progress.stage = 'Done';
  job.status = 'done';
}

function newJob(total, stage = 'Queued') {
  const job = { id: randomUUID(), status: 'queued', createdAt: Date.now(), progress: { done: 0, total, stage }, result: null, error: null };
  jobs.set(job.id, job);
  for (const [id, j] of jobs) {
    if (Date.now() - j.createdAt > JOB_TTL_MS) { jobs.delete(id); jobState.delete(id); }
  }
  return job;
}

export async function createJob(body, user = null) {
  const spec = validate(body);
  spec.projectId = await assertProjectAccess(spec.projectId, user);
  const job = newJob(spec.ids.length * spec.methods.length);
  job.ownerId = user?.id || null;
  execute(job, spec, user).catch((e) => {
    job.status = 'error';
    job.error = e.message;
  });
  return job;
}

export function getJob(id, user = null) {
  const job = jobs.get(id);
  if (!job || (user && job.ownerId && job.ownerId !== user.id)) return null;
  const { ownerId, ...visible } = job;
  return visible;
}

const rowUpdate = (row) => {
  const { article_id, comment_id, run_id, method, ...rest } = row;
  return rest;
};

/** Re-runs only failed items of each method in a finished job and updates saved rows in place (FR-16). */
export async function retryJob(id, user = null) {
  const job = jobs.get(id);
  const state = jobState.get(id);
  if (!job || !state || (user && job.ownerId && job.ownerId !== user.id)) throw badRequest('Job not found (jobs are kept in memory for 2 hours)', 404);
  if (job.status === 'running') throw badRequest('The job is still running', 409);
  const { spec, items, targets, methodRuns } = state;
  const failed = methodRuns.map((run) => run.results.map((r, i) => (r.error ? i : -1)).filter((i) => i >= 0));
  const total = failed.reduce((s, f) => s + f.length, 0);
  if (!total) throw badRequest('Nothing to retry: no failed results');

  job.status = 'running';
  job.progress = { done: 0, total, stage: 'Retrying failed items' };
  (async () => {
    const before = methodRuns.map((run) => run.results.map((r) => (r.flags || []).join(',')));
    let offset = 0;
    for (let m = 0; m < methodRuns.length; m++) {
      const idx = failed[m];
      if (!idx.length) continue;
      const run = methodRuns[m];
      job.progress.stage = `Retrying ${run.methodName} (${idx.length} item(s))`;
      const base = offset;
      const out = await runMethod(spec.task, spec.methods[m], idx.map((i) => items[i]), idx.map((i) => targets[i]), spec.options, (d) => {
        job.progress.done = base + Math.min(d, idx.length);
      });
      idx.forEach((i, k) => { run.results[i] = out.results[k]; });
      run.fatal = out.fatal && out.results.every((r) => r.error) ? out.fatal : null;
      run.extra = { ...out.extra, ...run.extra };
      offset += idx.length;
    }
    finalizeRuns(spec, items, methodRuns);
    if (spec.save) {
      job.progress.stage = 'Updating saved results';
      for (let m = 0; m < methodRuns.length; m++) {
        const run = methodRuns[m];
        if (!run.runId || !run.rowIds) continue;
        const table = TASKS[spec.task].table;
        const changed = run.results.map((r, i) => i).filter((i) => failed[m].includes(i) || (run.results[i].flags || []).join(',') !== before[m][i]);
        await mapLimit(changed, 5, async (i) => {
          check(await db().from(table).update(rowUpdate(rowFor(spec, spec.methods[m], run.runId, items[i], run.results[i]))).eq('id', run.rowIds[i]));
        });
        check(await db().from('analysis_runs').update({ status: run.status, error: run.fatal, summary: run.summary, updated_at: new Date().toISOString() }).eq('id', run.runId));
      }
    }
    job.result = publicResult(spec, items, methodRuns);
    job.progress.done = total;
    job.progress.stage = 'Done';
    job.status = 'done';
  })().catch((e) => {
    job.status = 'error';
    job.error = e.message;
  });
  return getJob(id);
}

/** Retries the failed rows of a saved run (e.g. after a provider outage) without touching completed rows. */
export async function retrySavedRun(runId, user = null) {
  const run = check(await db().from('analysis_runs').select('*').eq('id', runId).maybeSingle());
  if (!run) throw badRequest('Run not found', 404);
  const t = TASKS[run.task];
  if (!t) throw badRequest(`Unknown task "${run.task}"`);
  const { method } = getMethod(run.task, run.method);
  const failedRows = check(await db().from(t.table).select('*').eq('run_id', run.id).eq('status', 'failed'));
  if (!failedRows.length) throw badRequest('Nothing to retry: this run has no failed results');

  const job = newJob(failedRows.length, 'Loading failed items');
  job.ownerId = user?.id || null;
  const spec = { task: run.task, target: run.target_type, options: run.options || {}, projectId: run.project_id };
  (async () => {
    job.status = 'running';
    const ids = failedRows.map((r) => (run.target_type === 'comments' ? r.comment_id : r.article_id));
    const items = await loadItems(run.target_type, ids);
    const byId = new Map(items.map((it) => [it.id, it]));
    const pairs = failedRows.map((row, k) => ({ row, item: byId.get(ids[k]) })).filter((p) => p.item);
    const list = pairs.map((p) => p.item);
    const targets = t.needsTargets ? await loadStanceTargets(list) : list.map(() => null);
    job.progress.stage = `Retrying ${method.name}`;
    const out = await runMethod(run.task, method, list, targets, spec.options, (d) => { job.progress.done = d; });
    const single = [{ kind: method.kind, results: out.results }];
    computeFlags(single, aggregationRules(run.task, spec.options));
    await mapLimit(pairs, 5, async ({ row }, k) => {
      check(await db().from(t.table).update(rowUpdate(rowFor(spec, method, run.id, list[k], out.results[k]))).eq('id', row.id));
    });
    const all = check(await db().from(t.table).select(`${t.labelColumn},confidence,status,error,flags`).eq('run_id', run.id));
    const results = all.map((r) => (r.status === 'failed' ? { error: r.error } : r.status === 'ineligible' ? { status: 'ineligible' } : { label: r[t.labelColumn], confidence: r.confidence, flags: r.flags }));
    const summary = { ...(run.summary || {}), ...summarize(results) };
    check(await db().from('analysis_runs').update({ status: runStatus(results, null), error: null, summary, updated_at: new Date().toISOString() }).eq('id', run.id));
    const fixed = out.results.filter((r) => !r.error).length;
    job.result = { runId: run.id, retried: pairs.length, fixed, stillFailed: pairs.length - fixed };
    job.progress.done = job.progress.total;
    job.progress.stage = 'Done';
    job.status = 'done';
  })().catch((e) => {
    job.status = 'error';
    job.error = e.message;
  });
  return getJob(job.id);
}
