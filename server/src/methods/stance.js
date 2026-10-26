import { config } from '../config.js';
import { clamp, mapLimit, splitSentences, tick, truncate } from '../text.js';
import { vaderCompound } from './sentiment.js';
import { hfZeroShot } from '../providers/huggingface.js';
import { openaiClassify } from '../providers/openai.js';

export const STANCE_LABELS = ['favor', 'against', 'neutral'];

function requireTarget(opts) {
  const target = String(opts.target || '').trim();
  if (!target) {
    const err = new Error('Stance detection needs a target (e.g. "carbon tax")');
    err.status = 400;
    throw err;
  }
  return target;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const lexiconStance = {
  id: 'lexicon-target',
  name: 'Target-sentence sentiment',
  kind: 'lexicon',
  provider: null,
  description:
    'Baseline: finds sentences mentioning the target (or its keywords) and scores them with VADER. Positive → favor, negative → against. A rough proxy—sentiment is not the same as stance.',
  async run(items, opts, ctx) {
    const target = requireTarget(opts);
    const keywords = [target, ...String(opts.targetKeywords || '').split(',')]
      .map((k) => k.trim())
      .filter(Boolean);
    const re = new RegExp(`\\b(${keywords.map(escapeRegex).join('|')})`, 'i');
    const results = [];
    for (let i = 0; i < items.length; i++) {
      const hits = splitSentences(items[i].text).filter((s) => re.test(s));
      if (!hits.length) {
        results.push({ label: 'neutral', confidence: 0.3, score: 0, rationale: 'target not mentioned' });
      } else {
        const compound = vaderCompound(hits.join(' '));
        const label = compound >= 0.05 ? 'favor' : compound <= -0.05 ? 'against' : 'neutral';
        results.push({
          label,
          score: compound,
          confidence: label === 'neutral' ? 0.5 : clamp(0.5 + Math.abs(compound) / 2),
          rationale: `${hits.length} mention(s), compound ${compound.toFixed(3)}`,
        });
      }
      if (i % 25 === 24) { ctx.onProgress(i + 1); await tick(); }
    }
    ctx.onProgress(items.length);
    return { results };
  },
};

export const zeroShotStance = {
  id: 'hf-zero-shot',
  name: 'Zero-shot NLI (Hugging Face)',
  kind: 'transformer',
  provider: 'huggingface',
  description:
    'Natural-language-inference model (default facebook/bart-large-mnli) tests hypotheses such as "The author is in favor of X". Uses the first ~2,500 characters.',
  async run(items, opts, ctx) {
    const target = requireTarget(opts);
    const model = opts.hfZeroShotModel || 'facebook/bart-large-mnli';
    const candidates = [`in favor of ${target}`, `against ${target}`, `neutral about ${target}`];
    let done = 0;
    const results = await mapLimit(items, 4, async (item) => {
      try {
        const ranked = await hfZeroShot(model, truncate(item.text, 2500), candidates, 'The author of this text is {}.');
        const idx = candidates.indexOf(ranked[0].label);
        return { label: STANCE_LABELS[idx] ?? 'neutral', confidence: clamp(ranked[0].score) };
      } catch (e) {
        return { error: e.message };
      } finally {
        ctx.onProgress(++done);
      }
    });
    return { results, summary: { model, target } };
  },
};

export const openaiStance = {
  id: 'openai',
  name: 'OpenAI (LLM)',
  kind: 'llm',
  provider: 'openai',
  description: 'Large language model determines the author’s stance toward the target and explains why.',
  async run(items, opts, ctx) {
    const target = requireTarget(opts);
    const results = await openaiClassify(items, {
      labels: STANCE_LABELS,
      definitions: {
        favor: `the author supports or endorses "${truncate(target, 200)}"`,
        against: `the author opposes or criticises "${truncate(target, 200)}"`,
        neutral: 'no determinable author position: balanced reporting, only quoting other people, or the target is not discussed',
      },
      task: `stance detection toward the target "${truncate(target, 200)}". Code the AUTHOR's stance; positions of people quoted in the text are not the author's stance. Stance is not sentiment: negative language can still favour the target.${opts.instructions ? ` Additional instructions: ${truncate(opts.instructions, 500)}` : ''}`,
      model: opts.openaiModel,
      onProgress: ctx.onProgress,
    });
    return { results, summary: { model: opts.openaiModel || config.openaiModel, target } };
  },
};

export const stanceMethods = [lexiconStance, zeroShotStance, openaiStance];
