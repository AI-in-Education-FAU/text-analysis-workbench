import { supabase } from './supabase';

const ARTICLE_LIST_COLUMNS = 'id,title,source,source_type,keyword,author,published_date,url,is_relevant,processing_status';
const COMMENT_LIST_COLUMNS = 'id,article_id,text,published_date,parent_comment_id,articles!inner(title,source,source_type,keyword)';

function unwrap({ data, error, count }) {
  if (error) {
    const hint = /permission|policy|RLS/i.test(error.message)
      ? ' — check the read policies in supabase/migrations (are you signed in?)'
      : '';
    throw new Error(error.message + hint);
  }
  return count === undefined || count === null ? data : { data, count };
}

// Characters with special meaning in PostgREST filter strings / LIKE patterns.
const safe = (s) => String(s || '').replace(/[,()%*\\]/g, ' ').trim();

/** Builds a PostgREST OR expression for a project's keywords/topics/authors (any criterion may match). */
function projectCriteria(p) {
  const parts = [];
  for (const k of p.keywords || []) {
    const s = safe(k);
    if (s) parts.push(`keyword.ilike.${s}`, `title.ilike.%${s}%`, `clean_content.ilike.%${s}%`);
  }
  for (const t of p.topics || []) {
    const s = safe(t);
    if (s) parts.push(`title.ilike.%${s}%`, `clean_content.ilike.%${s}%`);
  }
  for (const a of p.authors || []) {
    const s = safe(a);
    if (s) parts.push(`author.ilike.%${s}%`);
  }
  return parts.join(',');
}

/** FR-4/5/6: restricts a query to the active project's criteria, sources and date range. */
function applyProject(q, p, target) {
  if (!p) return q;
  const onArticles = target === 'comments' ? 'articles.' : '';
  const crit = projectCriteria(p);
  if (crit) q = target === 'comments' ? q.or(crit, { referencedTable: 'articles' }) : q.or(crit);
  if (p.sources?.length && !p.sources.includes('*')) q = q.in(`${onArticles}source`, p.sources);
  if (p.sourceTypes?.length) q = q.in(`${onArticles}source_type`, p.sourceTypes);
  if (p.dateFrom) q = q.gte('published_date', p.dateFrom);
  if (p.dateTo) q = q.lte('published_date', p.dateTo);
  return q;
}

function applyArticleFilters(q, f) {
  q = applyProject(q, f.project, 'articles');
  if (f.search) {
    const s = safe(f.search);
    q = q.or(`title.ilike.%${s}%,clean_content.ilike.%${s}%`);
  }
  if (f.source) q = q.eq('source', f.source);
  if (f.source_type) q = q.eq('source_type', f.source_type);
  if (f.keyword) q = q.eq('keyword', f.keyword);
  if (f.from) q = q.gte('published_date', f.from);
  if (f.to) q = q.lte('published_date', f.to);
  if (f.relevant === 'true') q = q.eq('is_relevant', true);
  if (f.relevant === 'false') q = q.eq('is_relevant', false);
  return q;
}

function applyCommentFilters(q, f) {
  q = applyProject(q, f.project, 'comments');
  if (f.search) q = q.ilike('text', `%${safe(f.search)}%`);
  if (f.article_id) q = q.eq('article_id', Number(f.article_id));
  if (f.source) q = q.eq('articles.source', f.source);
  if (f.keyword) q = q.eq('articles.keyword', f.keyword);
  if (f.from) q = q.gte('published_date', f.from);
  if (f.to) q = q.lte('published_date', f.to);
  if (f.topLevel === 'true') q = q.is('parent_comment_id', null);
  return q;
}

export async function queryItems(target, filters, page, pageSize) {
  const from = page * pageSize;
  if (target === 'articles') {
    let q = supabase.from('articles').select(ARTICLE_LIST_COLUMNS, { count: 'exact' });
    q = applyArticleFilters(q, filters).order('published_date', { ascending: false, nullsFirst: false }).order('id', { ascending: false });
    return unwrap(await q.range(from, from + pageSize - 1));
  }
  let q = supabase.from('comments').select(COMMENT_LIST_COLUMNS, { count: 'exact' });
  q = applyCommentFilters(q, filters).order('published_date', { ascending: false, nullsFirst: false }).order('id', { ascending: false });
  return unwrap(await q.range(from, from + pageSize - 1));
}

/** Returns up to `max` ids matching the filters (Supabase pages are capped at 1000 rows). */
export async function fetchMatchingIds(target, filters, max) {
  const ids = [];
  const table = target === 'articles' ? 'articles' : 'comments';
  const columns = target === 'articles' ? 'id' : 'id,articles!inner(source,source_type)';
  const apply = target === 'articles' ? applyArticleFilters : applyCommentFilters;
  while (ids.length < max) {
    const from = ids.length;
    const to = Math.min(from + 999, max - 1);
    const rows = unwrap(await apply(supabase.from(table).select(columns), filters).order('id').range(from, to));
    ids.push(...rows.map((r) => r.id));
    if (rows.length < to - from + 1) break;
  }
  return ids;
}

export async function getArticle(id) {
  const article = unwrap(await supabase.from('articles').select('*').eq('id', id).single());
  const comments = unwrap(
    await supabase.from('comments').select('id,text,published_date,parent_comment_id').eq('article_id', id).order('id').limit(500),
  );
  return { article, comments };
}

export async function getComment(id) {
  return unwrap(await supabase.from('comments').select('*,articles(id,title,source,url)').eq('id', id).single());
}

export async function getFilterOptions() {
  const rows = unwrap(await supabase.from('articles').select('source,source_type,keyword').limit(10000));
  const distinct = (key) => [...new Set(rows.map((r) => r[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return { sources: distinct('source'), sourceTypes: distinct('source_type'), keywords: distinct('keyword') };
}

export async function getCounts() {
  const count = async (table, fn = (q) => q) => {
    const { count: n, error } = await fn(supabase.from(table).select('id', { count: 'exact', head: true }));
    if (error) throw new Error(error.message);
    return n ?? 0;
  };
  const [articles, relevant, comments] = await Promise.all([
    count('articles'),
    count('articles', (q) => q.eq('is_relevant', true)),
    count('comments'),
  ]);
  return { articles, relevant, comments };
}
