import { db, check } from './supabase.js';
import { normalize } from './text.js';

const CHUNK = 200;

async function fetchByIds(table, columns, ids) {
  const rows = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    rows.push(...check(await db().from(table).select(columns).in('id', part)));
  }
  const order = new Map(ids.map((id, i) => [Number(id), i]));
  return rows.sort((a, b) => order.get(Number(a.id)) - order.get(Number(b.id)));
}

function articleText(r) {
  const body = normalize(r.clean_content || r.content || '');
  const title = normalize(r.title || '');
  return title && !body.startsWith(title) ? `${title}. ${body}` : body;
}

/**
 * Loads articles or comments and converts them into a common "item" shape used by every method:
 * { id, type, article_id, comment_id, parent_comment_id, title, text, date, source, source_type, author }
 * `author` is only used server-side (stakeholder classification) and is never returned to the browser.
 */
export async function loadItems(target, ids) {
  if (target === 'articles') {
    const rows = await fetchByIds(
      'articles',
      'id,title,clean_content,content,source,source_type,published_date,keyword,author',
      ids,
    );
    return rows.map((r) => ({
      id: r.id,
      type: 'article',
      article_id: r.id,
      comment_id: null,
      parent_comment_id: null,
      title: normalize(r.title || ''),
      text: articleText(r),
      date: r.published_date,
      source: r.source,
      source_type: r.source_type,
      author: r.author || null,
    }));
  }
  if (target === 'comments') {
    const rows = await fetchByIds('comments', 'id,article_id,parent_comment_id,text,published_date,articles(title,source,source_type)', ids);
    return rows.map((r) => ({
      id: r.id,
      type: 'comment',
      article_id: r.article_id,
      comment_id: r.id,
      parent_comment_id: r.parent_comment_id,
      title: normalize(r.articles?.title || ''),
      text: normalize(r.text),
      date: r.published_date,
      source: r.articles?.source ?? null,
      source_type: r.articles?.source_type ?? null,
      author: null,
    }));
  }
  const err = new Error(`Unknown target "${target}"`);
  err.status = 400;
  throw err;
}

/**
 * Conversational stance target for each item: a reply targets its parent comment, a top-level
 * comment targets its article. Articles (and comments whose target cannot be found) get
 * { eligible: false, reason } so they are marked ineligible instead of guessed.
 */
export async function loadStanceTargets(items) {
  const parentIds = [...new Set(items.map((it) => it.parent_comment_id).filter(Boolean))];
  const articleIds = [...new Set(items.filter((it) => it.type === 'comment' && !it.parent_comment_id).map((it) => it.article_id))];
  const parents = new Map((parentIds.length ? await fetchByIds('comments', 'id,text', parentIds) : []).map((r) => [r.id, normalize(r.text)]));
  const articles = new Map(
    (articleIds.length ? await fetchByIds('articles', 'id,title,clean_content,content', articleIds) : []).map((r) => [r.id, articleText(r)]),
  );
  return items.map((it) => {
    if (it.type !== 'comment') return { eligible: false, reason: 'Articles have no conversational target; stance runs on comments and replies' };
    if (!it.text) return { eligible: false, reason: 'Empty response text' };
    if (it.parent_comment_id) {
      const text = parents.get(it.parent_comment_id);
      return text ? { eligible: true, type: 'comment', id: it.parent_comment_id, text } : { eligible: false, reason: 'Parent comment is missing or empty' };
    }
    const text = articles.get(it.article_id);
    return text ? { eligible: true, type: 'article', id: it.article_id, text } : { eligible: false, reason: 'Parent article is missing or empty' };
  });
}
