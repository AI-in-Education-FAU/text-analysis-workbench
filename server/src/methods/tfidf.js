import { tick } from '../text.js';

/**
 * Builds a TF-IDF matrix (dense rows, L2-normalised) over the most frequent terms.
 * Terms in fewer than `minDf` documents or in more than `maxDfRatio` of documents are dropped.
 */
export function buildTfidf(docsTokens, { maxTerms = 2000, minDf, maxDfRatio = 0.6, ngrams = 1 } = {}) {
  const D = docsTokens.length;
  const docsTerms = docsTokens.map((toks) => {
    if (ngrams < 2) return toks;
    const grams = [...toks];
    for (let i = 0; i + 1 < toks.length; i++) grams.push(`${toks[i]} ${toks[i + 1]}`);
    return grams;
  });
  const df = new Map();
  for (const terms of docsTerms) for (const t of new Set(terms)) df.set(t, (df.get(t) || 0) + 1);
  const lo = minDf ?? (D >= 10 ? 2 : 1);
  const hi = D >= 10 ? Math.max(2, Math.floor(maxDfRatio * D)) : D;
  const vocab = [...df.entries()]
    .filter(([, n]) => n >= lo && n <= hi)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([t]) => t);
  const index = new Map(vocab.map((t, i) => [t, i]));
  const idf = vocab.map((t) => Math.log((1 + D) / (1 + df.get(t))) + 1);
  const rows = docsTerms.map((terms) => {
    const row = new Float64Array(vocab.length);
    for (const t of terms) {
      const j = index.get(t);
      if (j !== undefined) row[j] += 1;
    }
    let norm = 0;
    for (let j = 0; j < row.length; j++) {
      if (row[j]) {
        row[j] = (1 + Math.log(row[j])) * idf[j];
        norm += row[j] * row[j];
      }
    }
    norm = Math.sqrt(norm);
    if (norm) for (let j = 0; j < row.length; j++) row[j] /= norm;
    return row;
  });
  return { vocab, rows, df, idf };
}

function seededRandom(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Non-negative matrix factorisation X ≈ W·H with Lee–Seung multiplicative updates (Frobenius loss). */
export async function nmf(rows, K, { iterations = 200, seed = 42 } = {}) {
  const D = rows.length;
  const V = rows[0]?.length || 0;
  const rand = seededRandom(seed);
  const W = Array.from({ length: D }, () => Float64Array.from({ length: K }, () => rand() + 0.01));
  const H = Array.from({ length: K }, () => Float64Array.from({ length: V }, () => rand() + 0.01));
  const eps = 1e-9;
  for (let it = 0; it < iterations; it++) {
    // H <- H * (Wᵀ X) / (Wᵀ W H)
    const WtW = Array.from({ length: K }, () => new Float64Array(K));
    for (const w of W) for (let a = 0; a < K; a++) for (let b = 0; b < K; b++) WtW[a][b] += w[a] * w[b];
    const WtX = Array.from({ length: K }, () => new Float64Array(V));
    for (let d = 0; d < D; d++) {
      const x = rows[d];
      const w = W[d];
      for (let j = 0; j < V; j++) {
        if (!x[j]) continue;
        for (let k = 0; k < K; k++) WtX[k][j] += w[k] * x[j];
      }
    }
    for (let k = 0; k < K; k++) {
      for (let j = 0; j < V; j++) {
        let denom = 0;
        for (let b = 0; b < K; b++) denom += WtW[k][b] * H[b][j];
        H[k][j] *= WtX[k][j] / (denom + eps);
      }
    }
    // W <- W * (X Hᵀ) / (W H Hᵀ)
    const HHt = Array.from({ length: K }, () => new Float64Array(K));
    for (let a = 0; a < K; a++) for (let b = 0; b < K; b++) {
      let s = 0;
      for (let j = 0; j < V; j++) s += H[a][j] * H[b][j];
      HHt[a][b] = s;
    }
    for (let d = 0; d < D; d++) {
      const x = rows[d];
      const w = W[d];
      const XHt = new Float64Array(K);
      for (let j = 0; j < V; j++) {
        if (!x[j]) continue;
        for (let k = 0; k < K; k++) XHt[k] += x[j] * H[k][j];
      }
      const next = new Float64Array(K);
      for (let k = 0; k < K; k++) {
        let denom = 0;
        for (let b = 0; b < K; b++) denom += w[b] * HHt[b][k];
        next[k] = w[k] * XHt[k] / (denom + eps);
      }
      W[d] = next;
    }
    if (it % 5 === 0) await tick();
  }
  return { W, H };
}
