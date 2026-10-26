import { pseudonym } from './auth.js';
import { TASKS } from './registry.js';
import { db, check } from './supabase.js';
import { truncate } from './text.js';

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const clean = (s) => String(s || '').replace(/[,()%*\\]/g, ' ').trim().slice(0, 100);
const DECISIONS = ['approve', 'correct', 'reject', 'exclude'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function taskOf(id) {
  const t = TASKS[id];
  if (!t) throw bad(`Unknown task "${id}"`);
  return t;
}

/** PostgREST "or" filter limiting analysis_runs to the user's own runs, runs in their projects, and legacy runs. */
export async function runVisibility(user) {
  if (!user) return null;
  const projects = check(await db().from('projects').select('id').eq('owner_id', user.id)).map((p) => p.id);
  const parts = [`created_by.eq.${user.id}`, 'created_by.is.null'];
  if (projects.length) parts.push(`project_id.in.(${projects.join(',')})`);
  return parts.join(',');
}

export async function assertRunAccess(runId, user) {
  const run = check(await db().from('analysis_runs').select('*').eq('id', runId).maybeSingle());
  if (!run) throw bad('Run not found', 404);
  if (user && run.created_by && run.created_by !== user.id) {
    const p = run.project_id ? check(await db().from('projects').select('owner_id').eq('id', run.project_id).maybeSingle()) : null;
    if (!p || p.owner_id !== user.id) throw bad('You do not have access to this run', 403);
  }
  return run;
}

/** Latest validation decision per result id. */
async function latestDecisions(table, resultIds) {
  const map = new Map();
  for (let i = 0; i < resultIds.length; i += 300) {
    const rows = check(await db().from('validation_decisions').select('*').eq('result_table', table).in('result_id', resultIds.slice(i, i + 300)).order('created_at', { ascending: false }));
    for (const r of rows) if (!map.has(r.result_id)) map.set(r.result_id, r);
  }
  return map;
}

async function decisionFilterIds(table, task, decision) {
  const rows = check(await db().from('validation_decisions').select('result_id,decision,created_at').eq('result_table', table).eq('task', task).order('created_at', { ascending: false }).limit(20000));
  const latest = new Map();
  for (const r of rows) if (!latest.has(r.result_id)) latest.set(r.result_id, r.decision);
  if (decision === 'unreviewed') return { exclude: [...latest.keys()] };
  return { include: [...latest].filter(([, d]) => d === decision).map(([id]) => id) };
}

/**
 * Builds the filtered result query shared by the table, the charts and exports so that all three
 * always describe the same dataset.
 */
async function buildQuery(params, user, select, opts = {}, light = false) {
  const t = taskOf(params.task);
  const target = params.target === 'comments' ? 'comments' : 'articles';
  const embed = target === 'comments'
    ? `articles!inner(id,title,source,source_type),comments!inner(id,${light ? '' : 'text,'}published_date,parent_comment_id)`
    : `articles!inner(id,title,source,source_type,published_date,author${light ? '' : ',clean_content,content'})`;
  let q = db().from(t.table).select(`${select},${embed},analysis_runs!inner(id,task,method,method_name,method_version,project_id,created_by,created_at${light ? '' : ',options'})`, opts)
    .eq('analysis_runs.task', params.task);
  q = target === 'comments' ? q.not('comment_id', 'is', null) : q.is('comment_id', null);
  const vis = await runVisibility(user);
  if (vis) q = q.or(vis, { referencedTable: 'analysis_runs' });
  if (params.projectId) q = q.eq('analysis_runs.project_id', params.projectId);
  if (params.runId) q = q.eq('run_id', params.runId);
  if (params.method) q = q.eq('method', params.method);
  if (params.label) q = q.eq(t.labelColumn, params.label);
  if (params.status) q = q.eq('status', params.status);
  if (params.flag === 'any') q = q.neq('flags', '{}');
  else if (params.flag) q = q.contains('flags', [params.flag]);
  if (params.maxConfidence !== undefined && params.maxConfidence !== '') q = q.lte('confidence', Number(params.maxConfidence));
  if (params.source) q = q.eq('articles.source', params.source);
  if (params.sourceType) q = q.eq('articles.source_type', params.sourceType);
  if (params.author && target === 'articles') q = q.ilike('articles.author', `%${clean(params.author)}%`);
  const dateCol = target === 'comments' ? 'comments.published_date' : 'articles.published_date';
  if (params.from && DATE.test(params.from)) q = q.gte(dateCol, params.from);
  if (params.to && DATE.test(params.to)) q = q.lte(dateCol, params.to);
  if (params.q && clean(params.q)) q = target === 'comments' ? q.ilike('comments.text', `%${clean(params.q)}%`) : q.ilike('articles.title', `%${clean(params.q)}%`);
  if (params.decision) {
    const f = await decisionFilterIds(t.table, params.task, params.decision);
    if (f.include) {
      if (!f.include.length) return { t, target, q: null };
      q = q.in('id', f.include.slice(0, 2000));
    } else if (f.exclude.length) {
      q = q.not('id', 'in', `(${f.exclude.slice(0, 2000).join(',')})`);
    }
  }
  return { t, target, q };
}

function shapeRow(t, target, r, decision) {
  const art = r.articles || {};
  const com = r.comments || {};
  const machineLabel = r[t.labelColumn];
  const finalLabel = decision?.decision === 'correct' ? decision.corrected_label : decision?.decision === 'reject' || decision?.decision === 'exclude' ? null : machineLabel;
  return {
    id: r.id,
    runId: r.run_id,
    method: r.method,
    methodName: r.analysis_runs?.method_name || r.method,
    methodVersion: r.analysis_runs?.method_version || null,
    runCreatedAt: r.analysis_runs?.created_at,
    label: machineLabel,
    confidence: r.confidence,
    status: r.status,
    error: r.error,
    flags: r.flags || [],
    rationale: r.rationale,
    evidence: r.evidence,
    score: r.score ?? null,
    keywords: r.keywords ?? null,
    targetType: r.target_type ?? null,
    targetId: r.target_id ?? null,
    item: {
      type: target === 'comments' ? 'comment' : 'article',
      id: target === 'comments' ? r.comment_id : r.article_id,
      article_id: r.article_id,
      parent_comment_id: com.parent_comment_id ?? null,
      title: art.title || '',
      snippet: truncate(target === 'comments' ? com.text || '' : art.clean_content || art.content || art.title || '', 300),
      date: target === 'comments' ? com.published_date : art.published_date,
      source: art.source,
      source_type: art.source_type,
      author: target === 'articles' ? pseudonym(art.author) : null,
    },
    decision: decision
      ? { decision: decision.decision, correctedLabel: decision.corrected_label, note: decision.note, reviewer: decision.reviewer_email, at: decision.created_at }
      : null,
    finalLabel,
    labelSource: decision ? (decision.decision === 'approve' ? 'validated' : decision.decision === 'correct' ? 'corrected' : 'rejected') : 'machine',
  };
}

export async function searchResults(params, user) {
  const page = Math.max(0, Number(params.page) || 0);
  const pageSize = Math.min(Math.max(1, Number(params.pageSize) || 50), 5000);
  const { t, target, q } = await buildQuery(params, user, '*', { count: 'exact' });
  if (!q) return { rows: [], total: 0, page, pageSize };
  const asc = params.sort === 'confidence_asc';
  const ordered = params.sort?.startsWith('confidence') ? q.order('confidence', { ascending: asc, nullsFirst: asc }) : q.order('id', { ascending: false });
  const { data, count } = check(await ordered.range(page * pageSize, page * pageSize + pageSize - 1));
  const decisions = await latestDecisions(t.table, data.map((r) => r.id));
  return { rows: data.map((r) => shapeRow(t, target, r, decisions.get(r.id))), total: count ?? data.length, page, pageSize };
}

/** Counts over the whole filtered set (up to 20,000 rows) for charts and trend reports. */
export async function summarizeResults(params, user) {
  const all = [];
  for (let from = 0; from < 20000; from += 1000) {
    const { t, target, q } = await buildQuery(params, user, `id,${taskOf(params.task).labelColumn},method,status,flags,confidence,run_id`, {}, true);
    if (!q) break;
    const page = check(await q.order('id').range(from, from + 999));
    all.push(...page.map((r) => ({ r, t, target })));
    if (page.length < 1000) break;
  }
  if (!all.length) return { total: 0, byLabel: {}, byMethod: {}, bySource: {}, byMonth: {}, flags: {}, status: {}, validated: {} };
  const { t, target } = all[0];
  const decisions = await latestDecisions(t.table, all.map(({ r }) => r.id));
  const inc = (obj, k, sub) => {
    if (sub === undefined) { obj[k] = (obj[k] || 0) + 1; return; }
    obj[k] = obj[k] || {};
    obj[k][sub] = (obj[k][sub] || 0) + 1;
  };
  const out = { total: all.length, byLabel: {}, byMethod: {}, bySource: {}, byMonth: {}, flags: {}, status: {}, validated: {}, truncated: all.length >= 20000 };
  for (const { r } of all) {
    const d = decisions.get(r.id);
    const label = r[t.labelColumn] ?? `(${r.status})`;
    inc(out.status, r.status);
    for (const f of r.flags || []) inc(out.flags, f);
    inc(out.validated, d ? d.decision : 'unreviewed');
    if (r.status !== 'ok') continue;
    inc(out.byLabel, label);
    inc(out.byMethod, r.method, label);
    inc(out.bySource, r.articles?.source || 'unknown', label);
    const date = target === 'comments' ? r.comments?.published_date : r.articles?.published_date;
    if (date) inc(out.byMonth, String(date).slice(0, 7), label);
  }
  return out;
}

export async function recordDecision(body, user) {
  const t = taskOf(body.task);
  const decision = String(body.decision || '');
  if (!DECISIONS.includes(decision)) throw bad(`decision must be one of ${DECISIONS.join(', ')}`);
  const row = check(await db().from(t.table).select('*').eq('id', Number(body.resultId)).maybeSingle());
  if (!row || !row.run_id) throw bad('Result not found', 404);
  const run = await assertRunAccess(row.run_id, user);
  if (run.task !== body.task) throw bad('Result does not belong to this task');
  let corrected = null;
  if (decision === 'correct') {
    corrected = String(body.correctedLabel || '').trim();
    if (!corrected) throw bad('A correction needs the corrected label');
    if (t.labels && !t.labels.includes(corrected)) throw bad(`Corrected label must be one of: ${t.labels.join(', ')}`);
  }
  return check(await db().from('validation_decisions').insert({
    run_id: row.run_id,
    task: body.task,
    result_table: t.table,
    result_id: row.id,
    item_type: row.comment_id ? 'comment' : 'article',
    item_id: row.comment_id || row.article_id,
    decision,
    original_label: row[t.labelColumn],
    corrected_label: corrected,
    note: body.note ? String(body.note).slice(0, 2000) : null,
    reviewer_id: user?.id || null,
    reviewer_email: user?.email || null,
  }).select('*').single());
}

export async function decisionHistory(task, resultId, user) {
  const t = taskOf(task);
  const rows = check(await db().from('validation_decisions').select('*').eq('result_table', t.table).eq('result_id', Number(resultId)).order('created_at', { ascending: false }));
  if (rows[0]?.run_id) await assertRunAccess(rows[0].run_id, user);
  return rows;
}

// Reference labels (human-coded sample used for evaluation) ------------------------------------

export async function listReferenceLabels(params) {
  taskOf(params.task);
  const itemType = params.itemType === 'comment' ? 'comment' : 'article';
  const out = [];
  const ids = params.ids ? String(params.ids).split(',').map(Number).filter(Number.isInteger) : null;
  const chunks = ids ? Array.from({ length: Math.ceil(ids.length / 300) }, (_, i) => ids.slice(i * 300, i * 300 + 300)) : [null];
  for (const chunk of chunks) {
    for (let from = 0; ; from += 1000) {
      let q = db().from('reference_labels').select('*').eq('task', params.task).eq('item_type', itemType);
      if (chunk) q = q.in('item_id', chunk);
      if (params.labelSource) q = q.eq('label_source', params.labelSource);
      if (params.guideVersion) q = q.eq('guide_version', params.guideVersion);
      if (params.projectId) q = q.eq('project_id', params.projectId);
      const page = check(await q.order('id').range(from, from + 999));
      out.push(...page);
      if (page.length < 1000) break;
    }
  }
  return out;
}

/**
 * Upserts reference labels. Partner labels can be supplied in their own vocabulary with a
 * `mapping` {partnerLabel: ourLabel}; both values are stored.
 */
export async function saveReferenceLabels(body, user) {
  const t = taskOf(body.task);
  const itemType = body.itemType === 'comment' ? 'comment' : 'article';
  const labelSource = body.labelSource === 'partner' ? 'partner' : 'team';
  const mapping = body.mapping && typeof body.mapping === 'object' ? body.mapping : null;
  const entries = Array.isArray(body.labels) ? body.labels : [];
  if (!entries.length) throw bad('No labels supplied');
  if (entries.length > 5000) throw bad('At most 5,000 labels per request');
  const errors = [];
  const rows = [];
  entries.forEach((e, i) => {
    const itemId = Number(e.itemId);
    const raw = String(e.label ?? '').trim();
    const label = mapping ? String(mapping[raw] ?? '').trim() : raw;
    if (!Number.isInteger(itemId)) return errors.push(`row ${i + 1}: invalid item id`);
    if (!label) return errors.push(`row ${i + 1}: ${mapping ? `no mapping for "${raw}"` : 'empty label'}`);
    if (t.labels && !t.labels.includes(label)) return errors.push(`row ${i + 1}: "${label}" is not a ${t.name} label`);
    rows.push({
      project_id: body.projectId || null,
      task: body.task,
      item_type: itemType,
      item_id: itemId,
      article_id: e.articleId ? Number(e.articleId) : itemType === 'article' ? itemId : null,
      label,
      original_label: labelSource === 'partner' || mapping ? raw : null,
      label_source: labelSource,
      annotator: String(body.annotator || user?.email || '').slice(0, 200),
      guide_version: String(body.guideVersion || 'v1').slice(0, 50),
      created_by: user?.id || null,
      updated_at: new Date().toISOString(),
    });
  });
  if (errors.length) throw Object.assign(bad(`Some labels were rejected: ${errors.slice(0, 10).join('; ')}${errors.length > 10 ? ` (+${errors.length - 10} more)` : ''}`), { fields: { labels: errors } });
  if (itemType === 'comment') {
    const missing = rows.filter((r) => !r.article_id);
    for (let i = 0; i < missing.length; i += 300) {
      const found = check(await db().from('comments').select('id,article_id').in('id', missing.slice(i, i + 300).map((r) => r.item_id)));
      const map = new Map(found.map((c) => [c.id, c.article_id]));
      for (const r of missing.slice(i, i + 300)) r.article_id = map.get(r.item_id) ?? null;
    }
  }
  const saved = [];
  for (let i = 0; i < rows.length; i += 500) {
    saved.push(...check(await db().from('reference_labels')
      .upsert(rows.slice(i, i + 500), { onConflict: 'task,item_type,item_id,label_source,annotator,guide_version' })
      .select('*')));
  }
  return saved;
}

export async function deleteReferenceLabel(id, user) {
  const row = check(await db().from('reference_labels').select('id,created_by').eq('id', Number(id)).maybeSingle());
  if (!row) throw bad('Reference label not found', 404);
  if (user && row.created_by && row.created_by !== user.id) throw bad('Only the annotator who created this label can delete it', 403);
  check(await db().from('reference_labels').delete().eq('id', row.id));
}
