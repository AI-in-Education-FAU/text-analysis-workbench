import { config } from '../config.js';
import { clamp, mapLimit, truncate } from '../text.js';
import { hfZeroShot } from '../providers/huggingface.js';
import { openaiClassify } from '../providers/openai.js';

/**
 * Parses a researcher-defined codebook. Accepts an array of {label, definition} or text with
 * one label per line, optionally followed by ":" and a definition.
 */
export function parseCodebook(raw) {
  const entries = Array.isArray(raw)
    ? raw.map((e) => (typeof e === 'string' ? { label: e } : e))
    : String(raw || '').split('\n').map((line) => {
      const i = line.indexOf(':');
      return i > 0 ? { label: line.slice(0, i), definition: line.slice(i + 1) } : { label: line };
    });
  const seen = new Set();
  const codebook = [];
  for (const e of entries) {
    const label = String(e.label || '').trim();
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    codebook.push({ label, definition: String(e.definition || '').trim() });
  }
  if (codebook.length < 2) {
    throw Object.assign(new Error('The codebook needs at least 2 labels (one per line, optionally "label: definition")'), { status: 400 });
  }
  return codebook.slice(0, 30);
}

export const zeroShotCodebook = {
  id: 'hf-zero-shot',
  name: 'Zero-shot NLI (Hugging Face)',
  kind: 'transformer',
  provider: 'huggingface',
  needsLabels: true,
  description: 'Applies your codebook labels as NLI hypotheses (“This text is about {label}.”). Definitions are not used, so make labels descriptive.',
  async run(items, opts, ctx) {
    const labels = parseCodebook(opts.codebook).map((c) => c.label);
    const model = opts.hfZeroShotModel || 'facebook/bart-large-mnli';
    const template = opts.hypothesisTemplate?.includes('{}') ? opts.hypothesisTemplate : 'This text is about {}.';
    let done = 0;
    const results = await mapLimit(items, 4, async (item) => {
      try {
        const ranked = await hfZeroShot(model, truncate(item.text, 2500), labels, template);
        return { label: ranked[0].label, confidence: clamp(ranked[0].score), rationale: ranked.slice(1, 3).map((r) => `${r.label} ${r.score.toFixed(2)}`).join(', ') };
      } catch (e) {
        return { error: e.message };
      } finally {
        ctx.onProgress(++done);
      }
    });
    return { results, summary: { model, hypothesisTemplate: template } };
  },
};

export const openaiCodebook = {
  id: 'openai',
  name: 'OpenAI (LLM)',
  kind: 'llm',
  provider: 'openai',
  needsLabels: true,
  description: 'Applies your codebook (labels + definitions) with a large language model and quotes a verified evidence span for each decision.',
  async run(items, opts, ctx) {
    const codebook = parseCodebook(opts.codebook);
    const results = await openaiClassify(items, {
      labels: codebook.map((c) => c.label),
      definitions: Object.fromEntries(codebook.map((c) => [c.label, c.definition])),
      task: `qualitative coding with the codebook "${truncate(opts.codebookName || 'custom', 100)}".${opts.instructions ? ` Additional instructions: ${truncate(opts.instructions, 800)}` : ''}`,
      model: opts.openaiModel,
      onProgress: ctx.onProgress,
    });
    return { results, summary: { model: opts.openaiModel || config.openaiModel } };
  },
};

export const codebookMethods = [zeroShotCodebook, openaiCodebook];
