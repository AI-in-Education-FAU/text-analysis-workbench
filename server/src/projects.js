import { TASKS } from './registry.js';
import { db, check } from './supabase.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const list = (v) => (Array.isArray(v) ? v : String(v || '').split(','))
  .map((s) => String(s).trim())
  .filter(Boolean)
  .slice(0, 100);

/**
 * FR-3/FR-4/FR-5/FR-6/FR-7/FR-30: validates a project before it is saved.
 * Returns { value, errors } where errors maps field -> message.
 */
export function validateProject(body = {}) {
  const errors = {};
  const name = String(body.name || '').trim();
  if (!name) errors.name = 'Project name is required';
  else if (name.length > 200) errors.name = 'Project name must be 200 characters or fewer';

  const c = body.config || {};
  const cfg = {
    keywords: list(c.keywords),
    topics: list(c.topics),
    authors: list(c.authors),
    sources: list(c.sources),
    sourceTypes: list(c.sourceTypes),
    dateFrom: c.dateFrom || null,
    dateTo: c.dateTo || null,
    target: ['articles', 'comments'].includes(c.target) ? c.target : 'articles',
    analyses: list(c.analyses).filter((a) => TASKS[a]),
    confidenceThreshold: c.confidenceThreshold === undefined || c.confidenceThreshold === '' ? 0.6 : Number(c.confidenceThreshold),
  };
  if (!cfg.keywords.length && !cfg.topics.length && !cfg.authors.length) {
    errors.criteria = 'Add at least one search criterion (keyword, topic or author)';
  }
  if (!cfg.sources.length && !cfg.sourceTypes.length) errors.sources = 'Select at least one data source (or "All supported sources")';
  for (const k of ['dateFrom', 'dateTo']) {
    if (cfg[k] && (!DATE.test(cfg[k]) || Number.isNaN(Date.parse(cfg[k])))) errors[k] = 'Use a valid date (YYYY-MM-DD)';
  }
  if (!errors.dateFrom && !errors.dateTo && cfg.dateFrom && cfg.dateTo && cfg.dateFrom > cfg.dateTo) {
    errors.dateTo = 'End date must be on or after the start date';
  }
  if (!Number.isFinite(cfg.confidenceThreshold) || cfg.confidenceThreshold < 0 || cfg.confidenceThreshold > 1) {
    errors.confidenceThreshold = 'Confidence threshold must be between 0 and 1';
  }
  return { value: { name, description: String(body.description || '').trim().slice(0, 2000) || null, config: cfg }, errors };
}

function invalid(errors) {
  const err = new Error(`Please fix the project settings: ${Object.values(errors).join('; ')}`);
  err.status = 400;
  err.fields = errors;
  return err;
}

function needUser(user) {
  if (!user) throw Object.assign(new Error('Projects require sign-in (AUTH_DISABLED is set on the server)'), { status: 400 });
}

export async function listProjects(user) {
  needUser(user);
  return check(await db().from('projects').select('*').eq('owner_id', user.id).order('updated_at', { ascending: false }));
}

export async function getProject(id, user) {
  needUser(user);
  const p = check(await db().from('projects').select('*').eq('id', id).eq('owner_id', user.id).maybeSingle());
  if (!p) throw Object.assign(new Error('Project not found'), { status: 404 });
  return p;
}

export async function createProject(body, user) {
  needUser(user);
  const { value, errors } = validateProject(body);
  if (Object.keys(errors).length) throw invalid(errors);
  return check(await db().from('projects').insert({ ...value, owner_id: user.id }).select('*').single());
}

export async function updateProject(id, body, user) {
  await getProject(id, user);
  const { value, errors } = validateProject(body);
  if (Object.keys(errors).length) throw invalid(errors);
  return check(await db().from('projects').update({ ...value, updated_at: new Date().toISOString() }).eq('id', id).eq('owner_id', user.id).select('*').single());
}

export async function deleteProject(id, user) {
  await getProject(id, user);
  check(await db().from('projects').delete().eq('id', id).eq('owner_id', user.id));
}
