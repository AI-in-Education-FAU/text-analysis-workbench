import { config } from '../config.js';
import { clamp, mapLimit, tick, truncate } from '../text.js';
import { vaderCompound } from './sentiment.js';
import { hfZeroShot } from '../providers/huggingface.js';
import { openaiClassify } from '../providers/openai.js';

/**
 * Conversational stance (FR-17A): how a response relates to its stored target —
 * the article for a top-level comment, the parent comment for a reply.
 * Methods receive `ctx.targets[i]` = { eligible, type, id, text } or { eligible:false, reason }.
 */
export const CONV_STANCE_LABELS = ['support', 'oppose', 'question', 'neutral'];

export const CONV_STANCE_DEFINITIONS = {
  support: 'the response agrees with, endorses, defends or adds supporting reasons for the target',
  oppose: 'the response disagrees with, rejects, criticises or argues against the target',
  question: 'the response mainly asks for clarification, evidence or information about the target without taking a side',
  neutral: 'neutral comment: unrelated, off-topic, purely informational, or no position toward the target can be determined',
};

const SUPPORT_CUES = [
  /\b(i|totally|completely|fully|strongly) agree\b/i, /\bagreed\b/i, /\bexactly\b/i, /\bwell said\b/i, /\bso true\b/i,
  /\bgood point\b/i, /\bgreat (point|article|post)\b/i, /\bspot on\b/i, /\bthis\s*!+/i, /\b(yes|yep),/i, /\bcouldn'?t agree more\b/i,
  /\babsolutely\b/i, /\bthank(s| you) for (this|sharing|writing)\b/i, /^\s*\+1\b/, /\bvalid point\b/i,
];
const OPPOSE_CUES = [
  /\b(i )?disagree\b/i, /\bnot true\b/i, /\bthat'?s (wrong|false|nonsense|ridiculous)\b/i, /\bwrong\b/i, /\bnonsense\b/i,
  /\bmisleading\b/i, /\bridiculous\b/i, /\bno,/i, /\bnot at all\b/i, /\bi doubt\b/i, /\bfake news\b/i, /\bbs\b/i,
  /\bmissing the point\b/i, /\bwhat a joke\b/i, /\bhardly\b/i,
];
const QUESTION_START = /^(who|what|when|where|why|how|is|are|do|does|did|can|could|would|should|will|has|have|any(one|body))\b/i;

/** Transparent cue-phrase baseline. Exported for tests. */
export function cueStance(text) {
  const t = String(text || '').trim();
  const support = SUPPORT_CUES.filter((re) => re.test(t)).length;
  const oppose = OPPOSE_CUES.filter((re) => re.test(t)).length;
  const sentences = t.split(/(?<=[.!?])\s+/).filter(Boolean);
  const questions = sentences.filter((s) => s.trim().endsWith('?') || QUESTION_START.test(s.trim())).length;
  if (support > oppose) return { label: 'support', confidence: clamp(0.55 + 0.1 * (support - oppose), 0, 0.9), rationale: `${support} agreement cue(s)` };
  if (oppose > support) return { label: 'oppose', confidence: clamp(0.55 + 0.1 * (oppose - support), 0, 0.9), rationale: `${oppose} disagreement cue(s)` };
  if (questions && questions >= sentences.length / 2) return { label: 'question', confidence: 0.6, rationale: `${questions} of ${sentences.length} sentence(s) are questions` };
  const compound = vaderCompound(t);
  if (Math.abs(compound) >= 0.5) {
    return {
      label: compound > 0 ? 'support' : 'oppose',
      confidence: 0.4,
      score: compound,
      rationale: `no cue phrase; strong VADER tone ${compound.toFixed(2)} used as a weak proxy`,
    };
  }
  return { label: 'neutral', confidence: 0.45, score: compound, rationale: 'no agreement, disagreement or question cues' };
}

const ineligible = (t) => ({ status: 'ineligible', reason: t.reason });
const withTarget = (t, r) => ({ ...r, targetType: t.type, targetId: t.id });

export const cueConvStance = {
  id: 'cue-lexicon',
  name: 'Cue-phrase lexicon (baseline)',
  kind: 'lexicon',
  provider: null,
  version: 'cue-lexicon-1',
  description:
    'Traditional baseline: agreement/disagreement cue phrases and question syntax, falling back to strong VADER tone with low confidence. Fast and transparent; does not read the target text.',
  async run(items, _opts, ctx) {
    const results = [];
    for (let i = 0; i < items.length; i++) {
      const t = ctx.targets[i];
      results.push(t.eligible ? withTarget(t, cueStance(items[i].text)) : ineligible(t));
      if (i % 50 === 49) { ctx.onProgress(i + 1); await tick(); }
    }
    ctx.onProgress(items.length);
    return { results };
  },
};

export const zeroShotConvStance = {
  id: 'hf-zero-shot',
  name: 'Zero-shot NLI (Hugging Face)',
  kind: 'transformer',
  provider: 'huggingface',
  description:
    'NLI model (default facebook/bart-large-mnli) reads "Target: … Response: …" and tests hypotheses such as "The response supports the target."',
  async run(items, opts, ctx) {
    const model = opts.hfZeroShotModel || 'facebook/bart-large-mnli';
    const hyp = {
      support: 'agrees with and supports the target',
      oppose: 'disagrees with and opposes the target',
      question: 'asks a question about the target',
      neutral: 'is neutral or unrelated to the target',
    };
    const candidates = CONV_STANCE_LABELS.map((l) => hyp[l]);
    let done = 0;
    const results = await mapLimit(items, 4, async (item, i) => {
      const t = ctx.targets[i];
      try {
        if (!t.eligible) return ineligible(t);
        const premise = `Target: ${truncate(t.text, 900)}\nResponse: ${truncate(item.text, 1500)}`;
        const ranked = await hfZeroShot(model, premise, candidates, 'The response {}.');
        const label = CONV_STANCE_LABELS[candidates.indexOf(ranked[0].label)] ?? 'neutral';
        return withTarget(t, { label, confidence: clamp(ranked[0].score) });
      } catch (e) {
        return { error: e.message };
      } finally {
        ctx.onProgress(++done);
      }
    });
    return { results, summary: { model } };
  },
};

export const openaiConvStance = {
  id: 'openai',
  name: 'OpenAI agent (LLM)',
  kind: 'llm',
  provider: 'openai',
  description: 'LLM agent receives both the target and the response, applies the stance codebook and quotes verified evidence from the response.',
  async run(items, opts, ctx) {
    const eligibleIdx = items.map((_, i) => i).filter((i) => ctx.targets[i].eligible);
    const pairs = eligibleIdx.map((i) => ({ ...items[i], context: ctx.targets[i].text }));
    const base = items.length - eligibleIdx.length;
    ctx.onProgress(base);
    const out = await openaiClassify(pairs, {
      labels: CONV_STANCE_LABELS,
      definitions: CONV_STANCE_DEFINITIONS,
      task: `conversational stance detection. Each input has a "target" (the article or parent comment being replied to) and a "response". Label how the RESPONSE relates to the TARGET. Stance is not sentiment: an angry response can still support the target. "evidence" must be quoted from the response.${opts.instructions ? ` Additional instructions: ${truncate(opts.instructions, 500)}` : ''}`,
      model: opts.openaiModel,
      onProgress: (d) => ctx.onProgress(base + d),
    });
    const results = items.map((_, i) => (ctx.targets[i].eligible ? null : ineligible(ctx.targets[i])));
    eligibleIdx.forEach((i, k) => { results[i] = out[k].error ? out[k] : withTarget(ctx.targets[i], out[k]); });
    return { results, summary: { model: opts.openaiModel || config.openaiModel } };
  },
};

export const convStanceMethods = [cueConvStance, zeroShotConvStance, openaiConvStance];
