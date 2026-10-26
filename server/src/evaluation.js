import { tokenize } from './text.js';

export const DEFAULT_THRESHOLD = 0.6;

const hasLabel = (r) => r && !r.error && r.status !== 'ineligible' && r.label !== undefined && r.label !== null && r.label !== '';

/**
 * Enforces the shared result contract: every result is either a labelled result,
 * { error } (failed) or { status:'ineligible', reason }. Unknown labels become errors.
 */
export function normalizeResults(results, n, allowedLabels) {
  const allowed = allowedLabels ? new Map(allowedLabels.map((l) => [String(l).toLowerCase(), l])) : null;
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = results?.[i];
    if (!r) { out.push({ error: 'Method returned no result for this item' }); continue; }
    if (r.error || r.status === 'ineligible') { out.push(r); continue; }
    if (r.label === undefined || r.label === null || r.label === '') { out.push({ error: 'Method returned an empty label' }); continue; }
    if (allowed) {
      const label = allowed.get(String(r.label).toLowerCase());
      if (!label) { out.push({ error: `Invalid output label "${r.label}"` }); continue; }
      out.push({ ...r, label });
    } else {
      out.push(r);
    }
  }
  return out;
}

export function statusOf(r) {
  if (r.error) return 'failed';
  if (r.status === 'ineligible') return 'ineligible';
  return 'ok';
}

/**
 * Review flags (FR-22): low_confidence below the threshold, conflict when comparable methods
 * disagree on the same item, failed when no output was produced. Mutates results' `flags`.
 */
export function computeFlags(methodRuns, { threshold = DEFAULT_THRESHOLD, comparable = () => true, confidenceApplies = () => true } = {}) {
  const n = methodRuns[0]?.results.length || 0;
  for (let i = 0; i < n; i++) {
    const labels = new Set();
    for (const run of methodRuns) if (comparable(run) && hasLabel(run.results[i])) labels.add(run.results[i].label);
    const conflict = labels.size > 1;
    for (const run of methodRuns) {
      const r = run.results[i];
      const flags = [];
      if (r.error) flags.push('failed');
      else if (hasLabel(r)) {
        if (confidenceApplies(run) && Number.isFinite(r.confidence) && r.confidence < threshold) flags.push('low_confidence');
        if (conflict && comparable(run)) flags.push('conflict');
      }
      r.flags = flags;
    }
  }
}

export function summarize(results) {
  const counts = {};
  let confSum = 0;
  let confN = 0;
  let ok = 0;
  let failed = 0;
  let ineligible = 0;
  let flagged = 0;
  for (const r of results) {
    if (r.flags?.length) flagged++;
    if (r.error) { failed++; continue; }
    if (r.status === 'ineligible') { ineligible++; continue; }
    ok++;
    counts[r.label] = (counts[r.label] || 0) + 1;
    if (Number.isFinite(r.confidence)) { confSum += r.confidence; confN++; }
  }
  const eligible = results.length - ineligible;
  return {
    counts,
    total: results.length,
    analyzed: ok,
    errors: failed,
    ineligible,
    flagged,
    coverage: eligible ? ok / eligible : null,
    failureRate: eligible ? failed / eligible : null,
    meanConfidence: confN ? confSum / confN : null,
  };
}

/** Percent agreement and Cohen's kappa between every pair of methods (labelled items only). */
export function agreement(methodRuns) {
  const pairs = [];
  for (let a = 0; a < methodRuns.length; a++) {
    for (let b = a + 1; b < methodRuns.length; b++) {
      const A = methodRuns[a].results;
      const B = methodRuns[b].results;
      let n = 0;
      let same = 0;
      const ca = {};
      const cb = {};
      for (let i = 0; i < A.length; i++) {
        if (!hasLabel(A[i]) || !hasLabel(B[i])) continue;
        n++;
        if (A[i].label === B[i].label) same++;
        ca[A[i].label] = (ca[A[i].label] || 0) + 1;
        cb[B[i].label] = (cb[B[i].label] || 0) + 1;
      }
      const po = n ? same / n : null;
      let pe = 0;
      for (const label of Object.keys(ca)) pe += ((ca[label] || 0) / n) * ((cb[label] || 0) / n);
      const kappa = n && pe < 1 ? (po - pe) / (1 - pe) : null;
      pairs.push({ a: methodRuns[a].methodId, b: methodRuns[b].methodId, n, agreement: po, kappa });
    }
  }
  return pairs;
}

/**
 * UMass topic coherence (Mimno et al., 2011) for each topic's top words, computed on the analysed
 * documents. Values are ≤ 0; closer to 0 means the top words co-occur more often.
 */
export function umassCoherence(texts, topics, topN = 10) {
  const docSets = texts.map((t) => new Set(tokenize(t)));
  const docFreq = (w) => docSets.reduce((s, d) => s + (d.has(w) ? 1 : 0), 0);
  const coFreq = (a, b) => docSets.reduce((s, d) => s + (d.has(a) && d.has(b) ? 1 : 0), 0);
  return topics.map((t) => {
    const words = [...new Set((t.keywords || []).flatMap((k) => String(k).toLowerCase().split(/\s+/)))].filter(Boolean).slice(0, topN);
    let sum = 0;
    let pairs = 0;
    for (let m = 1; m < words.length; m++) {
      for (let l = 0; l < m; l++) {
        const dl = docFreq(words[l]);
        if (!dl) continue;
        sum += Math.log((coFreq(words[m], words[l]) + 1) / dl);
        pairs++;
      }
    }
    return { label: t.label, coherence: pairs ? sum / pairs : null };
  });
}
