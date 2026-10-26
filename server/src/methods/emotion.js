import { config } from '../config.js';
import { chunkText, clamp, mapLimit, truncate } from '../text.js';
import { hfTextClassification, hfZeroShot } from '../providers/huggingface.js';
import { openaiClassify } from '../providers/openai.js';

// Ekman's six basic emotions plus neutral, matching j-hartmann/emotion-english-distilroberta-base.
export const EMOTION_LABELS = ['anger', 'disgust', 'fear', 'joy', 'sadness', 'surprise', 'neutral'];

export const hfEmotion = {
  id: 'hf-emotion',
  name: 'Emotion DistilRoBERTa (Hugging Face)',
  kind: 'transformer',
  provider: 'huggingface',
  description:
    'Transformer fine-tuned on several English emotion datasets (j-hartmann/emotion-english-distilroberta-base). Long texts are chunked and averaged. Expressed emotion ≠ the author’s inner state.',
  async run(items, opts, ctx) {
    const model = opts.hfEmotionModel || 'j-hartmann/emotion-english-distilroberta-base';
    let done = 0;
    const results = await mapLimit(items, 4, async (item) => {
      try {
        const chunks = chunkText(item.text || '', 1000, 5);
        const totals = {};
        for (const chunk of chunks) {
          for (const { label, score } of await hfTextClassification(model, chunk)) {
            const l = label.toLowerCase();
            totals[l] = (totals[l] || 0) + score / chunks.length;
          }
        }
        const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]);
        return {
          label: ranked[0][0],
          confidence: clamp(ranked[0][1]),
          rationale: ranked.slice(1, 3).map(([l, s]) => `${l} ${s.toFixed(2)}`).join(', '),
        };
      } catch (e) {
        return { error: e.message };
      } finally {
        ctx.onProgress(++done);
      }
    });
    return { results, summary: { model } };
  },
};

export const zeroShotEmotion = {
  id: 'hf-zero-shot',
  name: 'Zero-shot NLI (Hugging Face)',
  kind: 'transformer',
  provider: 'huggingface',
  description: 'Scores each emotion label as an NLI hypothesis (“This text expresses anger.”) with facebook/bart-large-mnli.',
  async run(items, opts, ctx) {
    const model = opts.hfZeroShotModel || 'facebook/bart-large-mnli';
    let done = 0;
    const results = await mapLimit(items, 4, async (item) => {
      try {
        const ranked = await hfZeroShot(model, truncate(item.text, 2500), EMOTION_LABELS, 'This text expresses {}.');
        return { label: ranked[0].label, confidence: clamp(ranked[0].score) };
      } catch (e) {
        return { error: e.message };
      } finally {
        ctx.onProgress(++done);
      }
    });
    return { results, summary: { model } };
  },
};

export const openaiEmotion = {
  id: 'openai',
  name: 'OpenAI (LLM)',
  kind: 'llm',
  provider: 'openai',
  description: 'Large language model picks the dominant expressed emotion and quotes a verified evidence span.',
  async run(items, opts, ctx) {
    const results = await openaiClassify(items, {
      labels: EMOTION_LABELS,
      definitions: { neutral: 'no clear emotion is expressed' },
      task: `emotion detection. Identify the dominant emotion the author expresses in each text (not emotions merely described or attributed to others).${opts.instructions ? ` Additional instructions: ${truncate(opts.instructions, 500)}` : ''}`,
      model: opts.openaiModel,
      onProgress: ctx.onProgress,
    });
    return { results, summary: { model: opts.openaiModel || config.openaiModel } };
  },
};

export const emotionMethods = [hfEmotion, zeroShotEmotion, openaiEmotion];
