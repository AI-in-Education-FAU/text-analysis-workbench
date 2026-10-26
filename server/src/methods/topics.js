import { config } from '../config.js';
import { clamp, mapLimit, tokenize, truncate } from '../text.js';
import { runLDA } from './lda.js';
import { buildTfidf, nmf } from './tfidf.js';
import { hfZeroShot } from '../providers/huggingface.js';
import { chatJSON, openaiClassify, SYSTEM_GUARD } from '../providers/openai.js';

export function parseLabels(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/[,\n]/);
  return [...new Set(list.map((l) => String(l).trim()).filter(Boolean))].slice(0, 30);
}

export const ldaMethod = {
  id: 'lda',
  name: 'LDA (Gibbs sampling)',
  kind: 'statistical',
  provider: null,
  description:
    'Unsupervised Latent Dirichlet Allocation. Discovers N topics as word distributions; each document gets its dominant topic. Results depend on corpus size, N and preprocessing.',
  async run(items, opts, ctx) {
    const numTopics = Number(opts.numTopics) || 5;
    const { topics, docTopics, emptyDocs } = await runLDA(items.map((it) => tokenize(it.text)), {
      numTopics,
      iterations: clamp(Number(opts.iterations) || 200, 20, 2000),
      seed: Number(opts.seed) || 42,
    });
    const labelOf = (k) => `T${k + 1}: ${topics[k].keywords.slice(0, 3).join(', ')}`;
    const results = docTopics.map((row, d) => {
      if (emptyDocs[d] || !row.length) return { error: 'No usable words after preprocessing' };
      let best = 0;
      for (let k = 1; k < row.length; k++) if (row[k] > row[best]) best = k;
      return { label: labelOf(best), confidence: clamp(row[best]), keywords: topics[best].keywords };
    });
    ctx.onProgress(items.length);
    return {
      results,
      summary: { topics: topics.map((t) => ({ label: labelOf(t.id), keywords: t.keywords })), seed: Number(opts.seed) || 42 },
    };
  },
};

export const nmfMethod = {
  id: 'nmf',
  name: 'NMF (TF-IDF)',
  kind: 'statistical',
  provider: null,
  description:
    'Non-negative matrix factorisation of a TF-IDF matrix (unigrams + bigrams). Fast, readable baseline; document weights are not calibrated probabilities.',
  async run(items, opts, ctx) {
    const K = clamp(Math.floor(Number(opts.numTopics) || 5), 2, 50);
    const { vocab, rows } = buildTfidf(items.map((it) => tokenize(it.text)), { ngrams: 2 });
    if (!vocab.length) throw Object.assign(new Error('Not enough shared vocabulary for NMF; select more items'), { status: 400 });
    const { W, H } = await nmf(rows, K, { iterations: clamp(Number(opts.iterations) || 200, 20, 1000), seed: Number(opts.seed) || 42 });
    const topics = H.map((h, k) => {
      const keywords = [...h.keys()].sort((a, b) => h[b] - h[a]).slice(0, 8).map((j) => vocab[j]);
      return { label: `T${k + 1}: ${keywords.slice(0, 3).join(', ')}`, keywords };
    });
    const results = W.map((w) => {
      const total = w.reduce((s, x) => s + x, 0);
      if (!total) return { error: 'No usable words after preprocessing' };
      let best = 0;
      for (let k = 1; k < K; k++) if (w[k] > w[best]) best = k;
      return { label: topics[best].label, confidence: clamp(w[best] / total), keywords: topics[best].keywords };
    });
    ctx.onProgress(items.length);
    return { results, summary: { topics, seed: Number(opts.seed) || 42 } };
  },
};

export const zeroShotTopics = {
  id: 'hf-zero-shot',
  name: 'Zero-shot classification (Hugging Face)',
  kind: 'transformer',
  provider: 'huggingface',
  needsLabels: true,
  description: 'Assigns each text to one of your predefined topic labels with an NLI model (default facebook/bart-large-mnli).',
  async run(items, opts, ctx) {
    const labels = parseLabels(opts.labels);
    if (labels.length < 2) {
      const err = new Error('Zero-shot topic classification needs at least 2 topic labels');
      err.status = 400;
      throw err;
    }
    const model = opts.hfZeroShotModel || 'facebook/bart-large-mnli';
    let done = 0;
    const results = await mapLimit(items, 4, async (item) => {
      try {
        const ranked = await hfZeroShot(model, truncate(item.text, 2500), labels, 'This text is about {}.');
        return { label: ranked[0].label, confidence: clamp(ranked[0].score), rationale: ranked.slice(1, 3).map((r) => `${r.label} ${r.score.toFixed(2)}`).join(', ') };
      } catch (e) {
        return { error: e.message };
      } finally {
        ctx.onProgress(++done);
      }
    });
    return { results, summary: { model, topics: labels.map((label) => ({ label, keywords: [] })) } };
  },
};

export const openaiTopics = {
  id: 'openai',
  name: 'OpenAI (LLM)',
  kind: 'llm',
  provider: 'openai',
  description:
    'With labels: classifies each text into your topics. Without labels: the model first proposes N topics from a sample, then classifies every text into them.',
  async run(items, opts, ctx) {
    let labels = parseLabels(opts.labels);
    let topics;
    if (labels.length < 2) {
      const n = clamp(Number(opts.numTopics) || 5, 2, 20);
      const step = Math.max(1, Math.floor(items.length / 40));
      const sample = items.filter((_, i) => i % step === 0).slice(0, 40).map((it) => truncate(it.text, 400));
      const proposal = await chatJSON({
        model: opts.openaiModel,
        system: `You are a research assistant doing inductive topic modeling. Read the sample texts and propose exactly ${n} distinct, mutually exclusive topics that cover the corpus. ${SYSTEM_GUARD} Respond as JSON {"topics":[{"label":"<2-5 word label>","keywords":["k1","k2","k3","k4","k5"]}]}.`,
        user: JSON.stringify({ sample }),
      });
      topics = (proposal.topics || []).filter((t) => t?.label).slice(0, n).map((t) => ({ label: String(t.label).trim(), keywords: (t.keywords || []).map(String) }));
      labels = topics.map((t) => t.label);
      if (labels.length < 2) throw new Error('OpenAI did not propose usable topics');
    } else {
      topics = labels.map((label) => ({ label, keywords: [] }));
    }
    const allLabels = labels.some((l) => l.toLowerCase() === 'other') ? labels : [...labels, 'other'];
    const results = await openaiClassify(items, {
      labels: allLabels,
      task: `topic classification. Assign each text to the single topic it is mainly about; use "other" if none fits.${opts.instructions ? ` Additional instructions: ${truncate(opts.instructions, 500)}` : ''}`,
      model: opts.openaiModel,
      onProgress: ctx.onProgress,
    });
    return { results, summary: { topics, model: opts.openaiModel || config.openaiModel } };
  },
};

export const topicMethods = [ldaMethod, nmfMethod, zeroShotTopics, openaiTopics];
