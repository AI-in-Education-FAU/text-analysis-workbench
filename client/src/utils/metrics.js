/** True when a result carries a label (not failed, not ineligible). */
export const hasLabel = (r) => Boolean(r) && !r.error && r.status !== 'ineligible' && r.label !== undefined && r.label !== null;

/** Pairwise percent agreement and Cohen's kappa between methods (same item order). */
export function pairwiseAgreement(methods) {
  const pairs = [];
  for (let a = 0; a < methods.length; a++) {
    for (let b = a + 1; b < methods.length; b++) {
      const A = methods[a].results;
      const B = methods[b].results;
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
      for (const l of Object.keys(ca)) pe += ((ca[l] || 0) / n) * ((cb[l] || 0) / n);
      pairs.push({ a: methods[a].methodName, b: methods[b].methodName, n, agreement: po, kappa: n && pe < 1 ? (po - pe) / (1 - pe) : null });
    }
  }
  return pairs;
}

/** Accuracy, macro-F1, per-class precision/recall/F1 and a confusion matrix against human labels. */
export function evaluate(predicted, gold, labels) {
  const pairs = [];
  predicted.forEach((p, i) => {
    if (gold[i] && hasLabel(p)) pairs.push([gold[i], p.label]);
  });
  const allLabels = [...new Set([...labels, ...pairs.flat()])];
  const matrix = Object.fromEntries(allLabels.map((g) => [g, Object.fromEntries(allLabels.map((p) => [p, 0]))]));
  for (const [g, p] of pairs) matrix[g][p]++;
  const perClass = allLabels.map((l) => {
    const tp = matrix[l][l];
    const fp = allLabels.reduce((s, g) => s + (g === l ? 0 : matrix[g][l]), 0);
    const fn = allLabels.reduce((s, p) => s + (p === l ? 0 : matrix[l][p]), 0);
    const precision = tp + fp ? tp / (tp + fp) : null;
    const recall = tp + fn ? tp / (tp + fn) : null;
    const f1 = precision && recall ? (2 * precision * recall) / (precision + recall) : precision === null || recall === null ? null : 0;
    return { label: l, support: tp + fn, predicted: tp + fp, precision, recall, f1 };
  });
  const scored = perClass.filter((c) => c.support > 0);
  const correct = pairs.filter(([g, p]) => g === p).length;
  return {
    n: pairs.length,
    accuracy: pairs.length ? correct / pairs.length : null,
    macroF1: scored.length ? scored.reduce((s, c) => s + (c.f1 ?? 0), 0) / scored.length : null,
    perClass,
    matrix,
    labels: allLabels,
  };
}

export const pct = (x, digits = 0) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(digits)}%`);
export const num = (x, digits = 2) => (x === null || x === undefined || Number.isNaN(x) ? '—' : Number(x).toFixed(digits));

/** Deterministic pseudo-random sample of indices, so the same coding sample is shown each time. */
export function sampleIndices(n, k, seed = 1) {
  let s = seed >>> 0 || 1;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, Math.min(k, n)).sort((a, b) => a - b);
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join('; ') : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function downloadFile(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function toCSV(header, rows) {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[ch])
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const xmlName = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^([^A-Za-z_])/, '_$1');

/** FR-32: XML export with one <record> per row and one element per column. */
export function toXML(header, rows, { root = 'results', meta = {} } = {}) {
  const names = header.map(xmlName);
  const attrs = Object.entries(meta).map(([k, v]) => ` ${xmlName(k)}="${xmlEscape(v ?? '')}"`).join('');
  const body = rows.map((r) => `  <record>\n${r.map((v, i) => {
    const s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join('; ') : String(v);
    return `    <${names[i]}>${xmlEscape(s)}</${names[i]}>`;
  }).join('\n')}\n  </record>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${xmlName(root)}${attrs}>\n${body}\n</${xmlName(root)}>\n`;
}

/** FR-26: stable pseudonym for a public author name (same algorithm as the server). */
export function pseudonym(author) {
  const s = String(author || '').trim().toLowerCase();
  if (!s) return null;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `Author-${h.toString(16).padStart(8, '0').slice(0, 6)}`;
}

/** Downloads rows as CSV, JSON or XML. */
export function exportRows(format, baseName, header, rows, meta = {}) {
  if (format === 'csv') return downloadFile(`${baseName}.csv`, toCSV(header, rows), 'text/csv');
  if (format === 'xml') return downloadFile(`${baseName}.xml`, toXML(header, rows, { meta }), 'application/xml');
  const records = rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? null])));
  return downloadFile(`${baseName}.json`, JSON.stringify({ ...meta, exportedAt: new Date().toISOString(), records }, null, 2), 'application/json');
}
