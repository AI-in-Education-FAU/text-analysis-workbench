import { config } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function hfRequest(model, body, retries = 4) {
  if (!config.hfToken) throw new Error('HF_TOKEN is not configured on the server');
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${config.hfBaseUrl}/${model}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.hfToken}`,
        'Content-Type': 'application/json',
        'x-wait-for-model': 'true',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    const text = await res.text();
    if ((res.status === 503 || res.status === 429) && attempt < retries) {
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    throw new Error(`Hugging Face ${res.status}: ${text.slice(0, 200)}`);
  }
}

/** Returns [{label, score}] for a text-classification model. */
export async function hfTextClassification(model, text) {
  let out = await hfRequest(model, { inputs: text });
  while (Array.isArray(out) && Array.isArray(out[0])) out = out[0];
  if (!Array.isArray(out)) throw new Error('Unexpected Hugging Face response');
  return out.map((r) => ({ label: String(r.label), score: Number(r.score) }));
}

/** Returns [{label, score}] sorted by score for a zero-shot (NLI) model. */
export async function hfZeroShot(model, text, candidateLabels, hypothesisTemplate) {
  const out = await hfRequest(model, {
    inputs: text,
    parameters: {
      candidate_labels: candidateLabels,
      multi_label: false,
      ...(hypothesisTemplate ? { hypothesis_template: hypothesisTemplate } : {}),
    },
  });
  let pairs;
  if (Array.isArray(out)) pairs = out.map((r) => ({ label: r.label, score: Number(r.score) }));
  else if (out && Array.isArray(out.labels)) pairs = out.labels.map((l, i) => ({ label: l, score: Number(out.scores[i]) }));
  else throw new Error('Unexpected Hugging Face zero-shot response');
  return pairs.sort((a, b) => b.score - a.score);
}
