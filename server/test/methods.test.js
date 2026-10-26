import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afinn, vaderMethod } from '../src/methods/sentiment.js';
import { lexiconStance } from '../src/methods/stance.js';
import { ldaMethod, nmfMethod } from '../src/methods/topics.js';
import { parseCodebook } from '../src/methods/classify.js';
import { agreement, summarize } from '../src/analyze.js';
import { evidenceInText } from '../src/providers/openai.js';
import { describeTasks } from '../src/registry.js';

const ctx = { onProgress: () => {} };
const item = (id, text) => ({ id, text });

test('lexicon sentiment methods label clear cases', async () => {
  const items = [item(1, 'This is wonderful, great and excellent news. I love it!'), item(2, 'This is terrible, awful and a horrible disaster.')];
  for (const m of [afinn, vaderMethod]) {
    const { results } = await m.run(items, {}, ctx);
    assert.equal(results[0].label, 'positive', m.id);
    assert.equal(results[1].label, 'negative', m.id);
    for (const r of results) assert.ok(r.confidence >= 0 && r.confidence <= 1);
  }
});

test('target-sentence stance requires a target and handles missing mentions', async () => {
  await assert.rejects(() => lexiconStance.run([item(1, 'x')], {}, ctx), /target/);
  const { results } = await lexiconStance.run(
    [item(1, 'The carbon tax is a great and wonderful idea.'), item(2, 'The weather was mild today.')],
    { target: 'carbon tax' },
    ctx,
  );
  assert.equal(results[0].label, 'favor');
  assert.equal(results[1].rationale, 'target not mentioned');
});

test('LDA and NMF separate two obvious themes', async () => {
  const sports = 'football match goal team player coach league stadium';
  const cooking = 'recipe oven flour sugar butter bake kitchen dough';
  const items = Array.from({ length: 12 }, (_, i) => item(i, i % 2 ? sports : cooking));
  for (const m of [ldaMethod, nmfMethod]) {
    const { results, summary } = await m.run(items, { numTopics: 2, iterations: 100 }, ctx);
    assert.equal(summary.topics.length, 2, m.id);
    assert.notEqual(results[0].label, results[1].label, m.id);
    assert.equal(results[0].label, results[2].label, m.id);
  }
});

test('agreement computes percent agreement and kappa', () => {
  const runs = [
    { methodId: 'a', results: [{ label: 'x' }, { label: 'y' }, { label: 'x' }, { label: 'y' }] },
    { methodId: 'b', results: [{ label: 'x' }, { label: 'y' }, { label: 'y' }, { error: 'e' }] },
  ];
  const [pair] = agreement(runs);
  assert.equal(pair.n, 3);
  assert.ok(Math.abs(pair.agreement - 2 / 3) < 1e-9);
  assert.equal(summarize(runs[1].results).errors, 1);
});

test('codebook parsing and evidence verification', () => {
  const cb = parseCodebook('economy: jobs, prices\nhealth\n\nEconomy');
  assert.deepEqual(cb.map((c) => c.label), ['economy', 'health']);
  assert.equal(cb[0].definition, 'jobs, prices');
  assert.throws(() => parseCodebook('only-one'), /at least 2/);
  assert.ok(evidenceInText('the BAN is overdue', 'I hate traffic; the ban is overdue!'));
  assert.ok(!evidenceInText('ban is great', 'I hate traffic; the ban is overdue!'));
});

test('registry exposes all tasks', () => {
  assert.deepEqual(describeTasks().map((t) => t.id), ['sentiment', 'stance', 'stakeholder', 'topics', 'target_stance', 'emotion', 'codebook']);
});
