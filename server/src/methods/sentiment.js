import Sentiment from 'sentiment';
import vader from 'vader-sentiment';
import { config } from '../config.js';
import { chunkText, clamp, mapLimit, splitSentences, tick, truncate } from '../text.js';
import { hfTextClassification } from '../providers/huggingface.js';
import { openaiClassify } from '../providers/openai.js';

export const SENTIMENT_LABELS = ['positive', 'neutral', 'negative'];

const afinnAnalyzer = new Sentiment();

function polarityLabel(score, threshold) {
  if (score >= threshold) return 'positive';
  if (score <= -threshold) return 'negative';
  return 'neutral';
}

export function vaderCompound(text) {
  const sentences = splitSentences(text);
  const list = sentences.length ? sentences : [text];
  let sum = 0;
  for (const s of list) sum += vader.SentimentIntensityAnalyzer.polarity_scores(s).compound;
  return sum / list.length;
}

export const afinn = {
  id: 'afinn',
  name: 'AFINN lexicon',
  kind: 'lexicon',
  provider: null,
  description:
    'Sums AFINN-165 word scores and normalises by length. Fast, transparent and reproducible, but blind to context, negation scope and sarcasm.',
  async run(items, _opts, ctx) {
    const results = [];
    for (let i = 0; i < items.length; i++) {
      const r = afinnAnalyzer.analyze(items[i].text || '');
      const label = polarityLabel(r.comparative, 0.05);
      results.push({
        label,
        score: r.comparative,
        confidence: label === 'neutral' ? 0.5 : clamp(0.5 + Math.abs(r.comparative)),
        rationale: [
          r.positive.length ? `+ ${[...new Set(r.positive)].slice(0, 6).join(', ')}` : '',
          r.negative.length ? `− ${[...new Set(r.negative)].slice(0, 6).join(', ')}` : '',
        ].filter(Boolean).join(' | '),
      });
      if (i % 50 === 49) { ctx.onProgress(i + 1); await tick(); }
    }
    ctx.onProgress(items.length);
    return { results };
  },
};

export const vaderMethod = {
  id: 'vader',
  name: 'VADER',
  kind: 'lexicon',
  provider: null,
  description:
    'Rule-based model tuned for social media; handles negation, intensifiers, punctuation and emoji. Document score is the mean sentence compound score.',
  async run(items, _opts, ctx) {
    const results = [];
    for (let i = 0; i < items.length; i++) {
      const compound = vaderCompound(items[i].text || '');
      const label = polarityLabel(compound, 0.05);
      results.push({
        label,
        score: compound,
        confidence: label === 'neutral' ? clamp(1 - Math.abs(compound) * 10, 0.5, 1) : clamp(0.5 + Math.abs(compound) / 2),
        rationale: `mean compound ${compound.toFixed(3)}`,
      });
      if (i % 25 === 24) { ctx.onProgress(i + 1); await tick(); }
    }
    ctx.onProgress(items.length);
    return { results };
  },
};

function mapSentimentLabel(raw) {
  const l = raw.toLowerCase();
  if (/^label_0$|neg/.test(l)) return 'negative';
  if (/^label_1$|neu/.test(l)) return 'neutral';
  if (/^label_2$|pos/.test(l)) return 'positive';
  const stars = l.match(/^(\d)\s*star/);
  if (stars) return Number(stars[1]) <= 2 ? 'negative' : Number(stars[1]) === 3 ? 'neutral' : 'positive';
  return null;
}

function hfSentimentMethod({ id, name, defaultModel, description }) {
  return {
    id,
    name,
    kind: 'transformer',
    provider: 'huggingface',
    description,
    async run(items, opts, ctx) {
      const model = (id === 'hf-roberta' && opts.hfSentimentModel) || defaultModel;
      let done = 0;
      const results = await mapLimit(items, 4, async (item) => {
        try {
          const chunks = chunkText(item.text || '', 1000, 5);
          const totals = { positive: 0, neutral: 0, negative: 0 };
          for (const chunk of chunks) {
            for (const { label, score } of await hfTextClassification(model, chunk)) {
              const mapped = mapSentimentLabel(label);
              if (mapped) totals[mapped] += score / chunks.length;
            }
          }
          const [label, confidence] = Object.entries(totals).sort((a, b) => b[1] - a[1])[0];
          return { label, confidence: clamp(confidence), score: totals.positive - totals.negative, rationale: `${chunks.length} chunk(s)` };
        } catch (e) {
          return { error: e.message };
        } finally {
          ctx.onProgress(++done);
        }
      });
      return { results, summary: { model } };
    },
  };
}

export const hfSentiment = hfSentimentMethod({
  id: 'hf-roberta',
  name: 'RoBERTa (Hugging Face)',
  defaultModel: 'cardiffnlp/twitter-roberta-base-sentiment-latest',
  description:
    'Transformer fine-tuned for 3-class sentiment on social text (default cardiffnlp/twitter-roberta-base-sentiment-latest). Long texts are split into up to 5 chunks and averaged.',
});

export const hfDistilbert = hfSentimentMethod({
  id: 'hf-distilbert-sst2',
  name: 'DistilBERT SST-2 (Hugging Face)',
  defaultModel: 'distilbert/distilbert-base-uncased-finetuned-sst-2-english',
  description:
    'Compact binary (positive/negative) model trained on movie reviews. Has no neutral class, so expect neutral texts to be forced into a polarity.',
});

export const openaiSentiment = {
  id: 'openai',
  name: 'OpenAI (LLM)',
  kind: 'llm',
  provider: 'openai',
  description: 'Large language model judges the author’s overall sentiment and quotes a verified evidence span. Context-aware but slower, paid, and non-deterministic.',
  async run(items, opts, ctx) {
    const results = await openaiClassify(items, {
      labels: SENTIMENT_LABELS,
      definitions: {
        positive: 'the author expresses an overall favourable or approving evaluation',
        neutral: 'factual/balanced or no clear evaluation; reported bad news is not by itself negative sentiment',
        negative: 'the author expresses an overall unfavourable or disapproving evaluation',
      },
      task: `sentiment analysis. Classify the overall sentiment (evaluative tone) the author expresses in each text.${opts.instructions ? ` Additional instructions: ${truncate(opts.instructions, 500)}` : ''}`,
      model: opts.openaiModel,
      onProgress: ctx.onProgress,
    });
    return { results, summary: { model: opts.openaiModel || config.openaiModel } };
  },
};

export const sentimentMethods = [afinn, vaderMethod, hfSentiment, hfDistilbert, openaiSentiment];
