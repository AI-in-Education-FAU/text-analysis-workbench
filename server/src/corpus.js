import { config } from './config.js';
import { loadItems } from './data.js';
import { buildTfidf } from './methods/tfidf.js';
import { chatJSON, evidenceInText, SYSTEM_GUARD } from './providers/openai.js';
import { tokenize, truncate } from './text.js';

function checkIds(target, ids) {
  if (!['articles', 'comments'].includes(target)) throw Object.assign(new Error('target must be "articles" or "comments"'), { status: 400 });
  if (!Array.isArray(ids) || !ids.length) throw Object.assign(new Error('No items selected'), { status: 400 });
  if (ids.length > config.maxItemsPerRun * 4) {
    throw Object.assign(new Error(`Too many items; the limit for corpus tools is ${config.maxItemsPerRun * 4}`), { status: 400 });
  }
  return [...new Set(ids.map(Number).filter(Number.isInteger))];
}

/** Lexical overview: term frequencies, distinctive TF-IDF terms, bigrams and per-document keyphrases. */
export async function keywords({ target, ids, top = 30 }) {
  const items = await loadItems(target, checkIds(target, ids));
  const tokens = items.map((it) => tokenize(it.text));
  const freq = new Map();
  const bigrams = new Map();
  let totalTokens = 0;
  for (const toks of tokens) {
    totalTokens += toks.length;
    for (const t of toks) freq.set(t, (freq.get(t) || 0) + 1);
    for (let i = 0; i + 1 < toks.length; i++) {
      const g = `${toks[i]} ${toks[i + 1]}`;
      bigrams.set(g, (bigrams.get(g) || 0) + 1);
    }
  }
  const { vocab, rows, df } = buildTfidf(tokens, { maxTerms: 5000, ngrams: 2, minDf: 1, maxDfRatio: 0.8 });
  const sums = new Float64Array(vocab.length);
  for (const row of rows) for (let j = 0; j < row.length; j++) sums[j] += row[j];
  const sortTop = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
  return {
    documents: items.length,
    totalTokens,
    uniqueTerms: freq.size,
    topTerms: sortTop(freq).map(([term, count]) => ({ term, count, perThousand: (1000 * count) / Math.max(1, totalTokens), docs: df.get(term) || 0 })),
    topBigrams: sortTop(bigrams).filter(([, c]) => c > 1).map(([term, count]) => ({ term, count })),
    distinctive: [...sums.keys()].sort((a, b) => sums[b] - sums[a]).slice(0, top).map((j) => ({ term: vocab[j], weight: sums[j] / items.length, docs: df.get(vocab[j]) })),
    perDocument: items.map((it, d) => ({
      id: it.id,
      title: it.title,
      keyphrases: [...rows[d].keys()].filter((j) => rows[d][j] > 0).sort((a, b) => rows[d][b] - rows[d][a]).slice(0, 6).map((j) => vocab[j]),
    })),
  };
}

/** Keyword-in-context concordance lines for a term or phrase. */
export async function concordance({ target, ids, term, window = 60, max = 500 }) {
  const q = String(term || '').trim();
  if (!q) throw Object.assign(new Error('Enter a term to search for'), { status: 400 });
  const items = await loadItems(target, checkIds(target, ids));
  const re = new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi');
  const lines = [];
  let docsWithHits = 0;
  for (const it of items) {
    let hit = false;
    for (const m of it.text.matchAll(re)) {
      hit = true;
      if (lines.length < max) {
        lines.push({
          id: it.id,
          title: it.title,
          left: it.text.slice(Math.max(0, m.index - window), m.index),
          match: m[0],
          right: it.text.slice(m.index + m[0].length, m.index + m[0].length + window),
        });
      }
    }
    if (hit) docsWithHits++;
  }
  return { term: q, documents: items.length, docsWithHits, lines };
}

/** Evidence-grounded LLM summary. Counts come from code, not from the model. */
export async function summarize({ target, ids, focus, model }) {
  const items = await loadItems(target, checkIds(target, ids));
  const step = Math.max(1, Math.ceil(items.length / 60));
  const sample = items.filter((_, i) => i % step === 0).slice(0, 60);
  const perText = Math.max(300, Math.floor(60000 / sample.length));
  const parsed = await chatJSON({
    model,
    system: [
      'You are a research assistant writing an evidence-grounded synthesis of a set of texts.',
      SYSTEM_GUARD,
      'Identify the main themes and notable minority views. Do not estimate counts or percentages.',
      'Every theme must cite supporting text ids and include one short verbatim quote copied exactly from one of them.',
      'Respond as JSON {"overview":"<3-5 sentences>","themes":[{"theme":"<label>","summary":"<1-3 sentences>","ids":[<ids>],"quote":"<verbatim>","quoteId":<id>}],"caveats":"<limitations of this sample>"}',
    ].join('\n'),
    user: JSON.stringify({
      focus: focus ? truncate(String(focus), 500) : 'general overview',
      texts: sample.map((it) => ({ id: it.id, text: truncate(it.text, perText) })),
    }),
  });
  const byId = new Map(sample.map((it) => [it.id, it]));
  const themes = (parsed.themes || []).map((t) => {
    const cited = (t.ids || []).map(Number).filter((id) => byId.has(id));
    const source = byId.get(Number(t.quoteId));
    return {
      theme: String(t.theme || ''),
      summary: String(t.summary || ''),
      ids: cited,
      quote: String(t.quote || ''),
      quoteId: source ? source.id : null,
      quoteVerified: source ? evidenceInText(t.quote, source.text) : false,
    };
  });
  return {
    overview: String(parsed.overview || ''),
    themes,
    caveats: String(parsed.caveats || ''),
    sampled: sample.length,
    selected: items.length,
    model: model || config.openaiModel,
  };
}
