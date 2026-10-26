import { providers } from './config.js';
import { sentimentMethods, SENTIMENT_LABELS } from './methods/sentiment.js';
import { stanceMethods, STANCE_LABELS } from './methods/stance.js';
import { convStanceMethods, CONV_STANCE_LABELS } from './methods/convstance.js';
import { stakeholderMethods, STAKEHOLDER_LABELS } from './methods/stakeholder.js';
import { topicMethods } from './methods/topics.js';
import { emotionMethods, EMOTION_LABELS } from './methods/emotion.js';
import { codebookMethods } from './methods/classify.js';

const BASELINE_KINDS = new Set(['lexicon', 'statistical']);

export const TASKS = {
  sentiment: {
    id: 'sentiment',
    name: 'Sentiment analysis',
    question: 'Is the tone of the text positive, negative or neutral?',
    table: 'sentiment_results',
    labelColumn: 'sentiment',
    labels: SENTIMENT_LABELS,
    methods: sentimentMethods,
  },
  stance: {
    id: 'stance',
    name: 'Conversational stance',
    question: 'Does a comment or reply support, oppose, question or ignore what it responds to (article or parent comment)?',
    table: 'stance_results',
    labelColumn: 'stance',
    labels: CONV_STANCE_LABELS,
    methods: convStanceMethods,
    needsTargets: true,
    targets: ['comments'],
  },
  stakeholder: {
    id: 'stakeholder',
    name: 'Author / stakeholder classification',
    question: 'Is the author a student, educator, researcher, administrator, other, or unknown?',
    table: 'classification_results',
    labelColumn: 'stakeholder_category',
    labels: STAKEHOLDER_LABELS,
    methods: stakeholderMethods,
  },
  topics: {
    id: 'topics',
    name: 'Topic modeling',
    question: 'What themes recur across the corpus?',
    table: 'topic_results',
    labelColumn: 'topic',
    labels: null,
    methods: topicMethods,
  },
  target_stance: {
    id: 'target_stance',
    name: 'Stance toward a proposition',
    question: 'Does the author favour or oppose a specific target/proposition you name?',
    table: 'stance_results',
    labelColumn: 'stance',
    labels: STANCE_LABELS,
    methods: stanceMethods,
  },
  emotion: {
    id: 'emotion',
    name: 'Emotion detection',
    question: 'Which emotion does the author express?',
    table: 'label_results',
    labelColumn: 'label',
    labels: EMOTION_LABELS,
    methods: emotionMethods,
  },
  codebook: {
    id: 'codebook',
    name: 'Custom codebook classification',
    question: 'Which of your predefined categories applies?',
    table: 'label_results',
    labelColumn: 'label',
    labels: null,
    methods: codebookMethods,
  },
};

export function isAvailable(method) {
  return !method.provider || providers[method.provider]();
}

export function isBaseline(method) {
  return BASELINE_KINDS.has(method.kind);
}

export function describeTasks() {
  return Object.values(TASKS).map((t) => ({
    id: t.id,
    name: t.name,
    question: t.question,
    labels: t.labels,
    targets: t.targets || ['articles', 'comments'],
    methods: t.methods.map((m) => ({
      id: m.id,
      name: m.name,
      kind: m.kind,
      baseline: isBaseline(m),
      provider: m.provider,
      description: m.description,
      needsLabels: Boolean(m.needsLabels),
      available: isAvailable(m),
    })),
  }));
}

export function getMethod(taskId, methodId) {
  const task = TASKS[taskId];
  if (!task) throw Object.assign(new Error(`Unknown task "${taskId}"`), { status: 400 });
  const method = task.methods.find((m) => m.id === methodId);
  if (!method) throw Object.assign(new Error(`Unknown method "${methodId}" for ${task.name}`), { status: 400 });
  if (!isAvailable(method)) {
    throw Object.assign(new Error(`${method.name} needs the ${method.provider} API key configured on the server`), { status: 400 });
  }
  return { task, method };
}
