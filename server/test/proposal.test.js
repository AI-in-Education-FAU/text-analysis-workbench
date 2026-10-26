import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cueConvStance, cueStance } from '../src/methods/convstance.js';
import { ruleStakeholder, STAKEHOLDER_LABELS } from '../src/methods/stakeholder.js';
import { computeFlags, normalizeResults, summarize, umassCoherence } from '../src/evaluation.js';
import { validateProject } from '../src/projects.js';
import { pseudonym } from '../src/auth.js';
import { describeTasks } from '../src/registry.js';

const ctx = (targets) => ({ onProgress: () => {}, targets });

test('cue-phrase conversational stance', () => {
  assert.equal(cueStance('I totally agree, well said.').label, 'support');
  assert.equal(cueStance('That is wrong and misleading.').label, 'oppose');
  assert.equal(cueStance('How do teachers detect this? Is there evidence?').label, 'question');
  assert.equal(cueStance('The meeting is on Tuesday.').label, 'neutral');
});

test('conversational stance marks items without a target as ineligible and keeps target ids', async () => {
  const items = [{ id: 1, text: 'I agree completely' }, { id: 2, text: 'An article body' }];
  const targets = [{ eligible: true, type: 'comment', id: 77, text: 'parent' }, { eligible: false, reason: 'no target' }];
  const { results } = await cueConvStance.run(items, {}, ctx(targets));
  assert.equal(results[0].label, 'support');
  assert.equal(results[0].targetId, 77);
  assert.equal(results[0].targetType, 'comment');
  assert.equal(results[1].status, 'ineligible');
});

test('stakeholder rules use explicit evidence and fall back to unknown', () => {
  assert.equal(ruleStakeholder('As a teacher, I see my students use ChatGPT daily.').label, 'educator');
  assert.equal(ruleStakeholder("I'm a college student and my professor banned AI.").label, 'student');
  assert.equal(ruleStakeholder('Our study found mixed effects of AI tutoring.').label, 'researcher');
  assert.equal(ruleStakeholder('AI will change everything.').label, 'unknown');
  assert.equal(ruleStakeholder('AI in schools', 'Jane Doe, Professor of Education').label, 'educator');
  for (const l of ['student', 'educator', 'researcher', 'administrator', 'other', 'unknown']) assert.ok(STAKEHOLDER_LABELS.includes(l));
});

test('normalizeResults rejects invalid labels and missing results', () => {
  const out = normalizeResults([{ label: 'Positive', confidence: 0.9 }, { label: 'maybe' }, { status: 'ineligible', reason: 'x' }], 4, ['positive', 'negative']);
  assert.equal(out[0].label, 'positive');
  assert.match(out[1].error, /Invalid output label/);
  assert.equal(out[2].status, 'ineligible');
  assert.match(out[3].error, /no result/);
});

test('flags low confidence, conflicts and failures; summary reports coverage', () => {
  const runs = [
    { kind: 'lexicon', results: [{ label: 'a', confidence: 0.9 }, { label: 'a', confidence: 0.3 }, { error: 'boom' }, { status: 'ineligible' }] },
    { kind: 'llm', results: [{ label: 'a', confidence: 0.9 }, { label: 'b', confidence: 0.8 }, { label: 'a', confidence: 0.9 }, { status: 'ineligible' }] },
  ];
  computeFlags(runs, { threshold: 0.6 });
  assert.deepEqual(runs[0].results[0].flags, []);
  assert.deepEqual(runs[0].results[1].flags, ['low_confidence', 'conflict']);
  assert.deepEqual(runs[1].results[1].flags, ['conflict']);
  assert.deepEqual(runs[0].results[2].flags, ['failed']);
  assert.deepEqual(runs[1].results[3].flags, []);
  const s = summarize(runs[0].results);
  assert.equal(s.ineligible, 1);
  assert.equal(s.errors, 1);
  assert.ok(Math.abs(s.coverage - 2 / 3) < 1e-9);
  assert.equal(s.flagged, 2);
});

test('UMass coherence prefers co-occurring words', () => {
  const texts = ['apple banana fruit', 'apple banana smoothie', 'car engine wheel', 'car engine road'];
  const [good, bad] = umassCoherence(texts, [{ label: 'g', keywords: ['apple', 'banana'] }, { label: 'b', keywords: ['apple', 'engine'] }]);
  assert.ok(good.coherence > bad.coherence);
});

test('project validation enforces FR-7', () => {
  const { errors } = validateProject({ name: '', config: { dateFrom: '2024-05-01', dateTo: '2024-01-01' } });
  assert.ok(errors.name && errors.criteria && errors.sources && errors.dateTo);
  const ok = validateProject({ name: 'AI in schools', config: { keywords: 'chatgpt, ai tutor', sources: ['*'], confidenceThreshold: '0.7' } });
  assert.deepEqual(ok.errors, {});
  assert.deepEqual(ok.value.config.keywords, ['chatgpt', 'ai tutor']);
  assert.equal(ok.value.config.confidenceThreshold, 0.7);
});

test('pseudonyms are stable and hide the name', () => {
  assert.equal(pseudonym('Jane Doe'), pseudonym(' jane doe '));
  assert.notEqual(pseudonym('Jane Doe'), pseudonym('John Roe'));
  assert.ok(!pseudonym('Jane Doe').includes('Jane'));
  assert.equal(pseudonym(''), null);
});

test('baseline methods are marked for every proposal task', () => {
  const tasks = Object.fromEntries(describeTasks().map((t) => [t.id, t]));
  for (const id of ['sentiment', 'stance', 'stakeholder', 'topics']) assert.ok(tasks[id].methods.some((m) => m.baseline), id);
  assert.deepEqual(tasks.stance.targets, ['comments']);
});
