import { tick } from '../text.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Latent Dirichlet Allocation fitted with collapsed Gibbs sampling.
 * @param {string[][]} docsTokens tokenised documents
 * @returns {{ topics: {id:number, keywords:string[]}[], docTopics: number[][], emptyDocs: boolean[] }}
 */
export async function runLDA(docsTokens, {
  numTopics = 5,
  iterations = 200,
  alpha = 0.1,
  beta = 0.01,
  topWords = 8,
  seed = 42,
  maxTokensPerDoc = 1000,
} = {}) {
  const D = docsTokens.length;
  const K = Math.max(2, Math.min(50, Math.floor(numTopics)));

  // Drop very rare and very common terms when there are enough documents.
  const df = new Map();
  for (const toks of docsTokens) for (const w of new Set(toks)) df.set(w, (df.get(w) || 0) + 1);
  const minDf = D >= 10 ? 2 : 1;
  const maxDf = D >= 10 ? Math.max(2, Math.floor(0.6 * D)) : D;
  const vocab = [];
  const index = new Map();
  for (const [w, n] of df) {
    if (n >= minDf && n <= maxDf) {
      index.set(w, vocab.length);
      vocab.push(w);
    }
  }
  const V = vocab.length;
  const docs = docsTokens.map((toks) => toks.filter((w) => index.has(w)).slice(0, maxTokensPerDoc).map((w) => index.get(w)));
  if (V === 0) {
    return { topics: [], docTopics: docs.map(() => []), emptyDocs: docs.map(() => true) };
  }

  const rand = mulberry32(seed);
  const nw = new Int32Array(V * K);
  const nd = new Int32Array(D * K);
  const nwsum = new Int32Array(K);
  const z = docs.map((doc, d) =>
    Int32Array.from(doc, (w) => {
      const k = Math.floor(rand() * K);
      nw[w * K + k]++;
      nd[d * K + k]++;
      nwsum[k]++;
      return k;
    }),
  );

  const p = new Float64Array(K);
  const Vbeta = V * beta;
  for (let iter = 0; iter < iterations; iter++) {
    for (let d = 0; d < D; d++) {
      const doc = docs[d];
      const zd = z[d];
      for (let i = 0; i < doc.length; i++) {
        const w = doc[i];
        let k = zd[i];
        nw[w * K + k]--;
        nd[d * K + k]--;
        nwsum[k]--;
        let total = 0;
        for (let t = 0; t < K; t++) {
          total += (nw[w * K + t] + beta) / (nwsum[t] + Vbeta) * (nd[d * K + t] + alpha);
          p[t] = total;
        }
        const u = rand() * total;
        for (k = 0; k < K - 1 && p[k] < u; k++);
        zd[i] = k;
        nw[w * K + k]++;
        nd[d * K + k]++;
        nwsum[k]++;
      }
    }
    if (iter % 10 === 0) await tick();
  }

  const topics = [];
  for (let k = 0; k < K; k++) {
    const scored = [];
    for (let w = 0; w < V; w++) scored.push([w, (nw[w * K + k] + beta) / (nwsum[k] + Vbeta)]);
    scored.sort((a, b) => b[1] - a[1]);
    topics.push({ id: k, keywords: scored.slice(0, topWords).map(([w]) => vocab[w]) });
  }
  const docTopics = docs.map((doc, d) => {
    const row = [];
    for (let k = 0; k < K; k++) row.push((nd[d * K + k] + alpha) / (doc.length + K * alpha));
    return row;
  });
  return { topics, docTopics, emptyDocs: docs.map((doc) => doc.length === 0) };
}
