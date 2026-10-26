import { test, expect } from '@playwright/test';
import { apiClient, createTestUser, deleteTestUser, env, sampleIds, signIn, testUser } from '../helpers.js';

/**
 * Exercises the analysis API directly (the same endpoints the website calls).
 * Fast, precise checks that every task/method still works after a deploy.
 */

let api;
let anon;
let cfg;
let commentIds;
let articleIds;

const VALID_LABELS = {
  sentiment: ['positive', 'neutral', 'negative'],
  stance: ['agree', 'disagree', 'neutral', 'unrelated'],
};

function expectHealthyRun(result, { methodIds, items }) {
  expect(result.methods.map((m) => m.methodId)).toEqual(methodIds);
  expect(result.items).toHaveLength(items);
  for (const m of result.methods) {
    expect(m.status, `${m.methodId}: ${m.error || JSON.stringify(m.results.find((r) => r.error))}`).not.toBe('failed');
    expect(m.results).toHaveLength(items);
    expect(m.summary.total).toBe(items);
    const analyzed = m.results.filter((r) => r.label !== undefined && r.label !== null && !r.error);
    expect(analyzed.length, `${m.methodId} labelled nothing`).toBeGreaterThan(0);
    for (const r of analyzed) {
      if (Number.isFinite(r.confidence)) {
        expect(r.confidence).toBeGreaterThanOrEqual(0);
        expect(r.confidence).toBeLessThanOrEqual(1);
      }
    }
  }
}

test.beforeAll(async () => {
  const { email, password } = testUser();
  const token = await signIn(email, password);
  api = apiClient(token);
  anon = apiClient(null);
  cfg = (await anon.get('/api/config')).body;
  commentIds = await sampleIds(token, 'comments', 20);
  articleIds = await sampleIds(token, 'articles', 10);
});

const methodsOf = (task, kinds) =>
  cfg.tasks.find((t) => t.id === task).methods.filter((m) => m.available && kinds.includes(m.kind)).map((m) => m.id);

test.describe('API basics', () => {
  test('config lists the services and all analysis tasks', async () => {
    expect(cfg.supabase).toBe(true);
    expect(cfg.authRequired).toBe(true);
    expect(cfg.tasks.map((t) => t.id)).toEqual(
      expect.arrayContaining(['sentiment', 'stance', 'stakeholder', 'topics', 'target_stance', 'emotion', 'codebook']),
    );
    for (const t of cfg.tasks) expect(t.methods.length, t.id).toBeGreaterThan(0);
  });

  test('the database has articles and comments to analyse', () => {
    expect(commentIds.length).toBeGreaterThan(5);
    expect(articleIds.length).toBeGreaterThan(5);
  });

  test('protected endpoints reject requests without a sign-in', async () => {
    expect((await anon.get('/api/projects')).status).toBe(401);
    expect((await anon.post('/api/analyze', { task: 'sentiment' })).status).toBe(401);
    expect((await apiClient('not-a-real-token').get('/api/runs')).status).toBe(401);
  });

  test('CORS allows the website origin', async () => {
    const res = await fetch(`${env.apiURL}/api/projects`, {
      method: 'OPTIONS',
      headers: { Origin: env.baseURL, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
    });
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get('access-control-allow-origin')).toBe(env.baseURL);
  });

  test('unknown API routes return 404 JSON', async () => {
    const r = await api.get('/api/does-not-exist');
    expect(r.status).toBe(404);
    expect(r.body.error).toBeTruthy();
  });
});

test.describe('Projects', () => {
  test('create, read, update, list and delete a project', async () => {
    const bad = await api.post('/api/projects', { name: '', config: { sources: ['*'] } });
    expect(bad.status).toBe(400);
    expect(bad.body.fields).toMatchObject({ name: expect.any(String), criteria: expect.any(String) });

    const created = await api.post('/api/projects', {
      name: 'E2E API project',
      description: 'created by the e2e suite',
      config: { keywords: 'AI, technology', sources: ['*'], target: 'comments', analyses: ['sentiment'], confidenceThreshold: 0.6 },
    });
    expect(created.status).toBe(201);
    expect(created.body.config.keywords).toEqual(['AI', 'technology']);
    const id = created.body.id;

    expect((await api.get(`/api/projects/${id}`)).body.name).toBe('E2E API project');

    const updated = await api.put(`/api/projects/${id}`, { ...created.body, name: 'E2E API project (renamed)' });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe('E2E API project (renamed)');

    const list = await api.get('/api/projects');
    expect(list.body.map((p) => p.id)).toContain(id);

    expect((await api.del(`/api/projects/${id}`)).status).toBe(200);
    expect((await api.get(`/api/projects/${id}`)).status).toBe(404);
  });

  test('invalid dates and thresholds are rejected', async () => {
    const r = await api.post('/api/projects', {
      name: 'bad',
      config: { keywords: 'AI', sources: ['*'], dateFrom: '2024-05-01', dateTo: '2024-01-01', confidenceThreshold: 2 },
    });
    expect(r.status).toBe(400);
    expect(Object.keys(r.body.fields)).toEqual(expect.arrayContaining(['dateTo', 'confidenceThreshold']));
  });
});

test.describe('Analysis input validation', () => {
  for (const [name, body] of [
    ['unknown task', { task: 'nope', target: 'comments', methods: ['afinn'], ids: [1] }],
    ['bad target', { task: 'sentiment', target: 'tweets', methods: ['afinn'], ids: [1] }],
    ['no methods', { task: 'sentiment', target: 'comments', methods: [], ids: [1] }],
    ['no items', { task: 'sentiment', target: 'comments', methods: ['afinn'], ids: [] }],
    ['unknown method', { task: 'sentiment', target: 'comments', methods: ['magic'], ids: [1] }],
    ['bad threshold', { task: 'sentiment', target: 'comments', methods: ['afinn'], ids: [1], options: { confidenceThreshold: 5 } }],
  ]) {
    test(`rejects ${name}`, async () => {
      const r = await api.post('/api/analyze', body);
      expect(r.status).toBe(400);
      expect(r.body.error).toBeTruthy();
    });
  }
});

test.describe('Local (free) methods', () => {
  test('sentiment: every lexicon method on comments', async () => {
    const methods = methodsOf('sentiment', ['lexicon']);
    expect(methods).toEqual(expect.arrayContaining(['afinn', 'vader']));
    const r = await api.analyze({ task: 'sentiment', target: 'comments', methods, ids: commentIds.slice(0, 10) });
    expectHealthyRun(r, { methodIds: methods, items: 10 });
    for (const m of r.methods) for (const x of m.results.filter((y) => y.label)) expect(VALID_LABELS.sentiment).toContain(x.label);
    expect(r.agreement.length).toBeGreaterThan(0);
  });

  test('sentiment: works on articles too', async () => {
    const r = await api.analyze({ task: 'sentiment', target: 'articles', methods: ['vader'], ids: articleIds.slice(0, 5) });
    expectHealthyRun(r, { methodIds: ['vader'], items: 5 });
  });

  test('stance: cue lexicon on comments', async () => {
    const methods = methodsOf('stance', ['lexicon']);
    const r = await api.analyze({ task: 'stance', target: 'comments', methods, ids: commentIds.slice(0, 10) });
    expect(r.methods.map((m) => m.methodId)).toEqual(methods);
    for (const m of r.methods) expect(m.status, m.error).not.toBe('failed');
  });

  test('stakeholder: self-identification rules', async () => {
    const methods = methodsOf('stakeholder', ['lexicon']);
    const r = await api.analyze({ task: 'stakeholder', target: 'comments', methods, ids: commentIds.slice(0, 10) });
    expect(r.methods.map((m) => m.methodId)).toEqual(methods);
    for (const m of r.methods) {
      expect(m.status, m.error).not.toBe('failed');
      expect(m.results).toHaveLength(10);
    }
  });

  test('topics: LDA and NMF produce topics with keywords and coherence', async () => {
    const methods = methodsOf('topics', ['statistical']);
    expect(methods).toEqual(expect.arrayContaining(['lda', 'nmf']));
    const r = await api.analyze({
      task: 'topics', target: 'comments', methods, ids: commentIds, options: { numTopics: 3, seed: 42 },
    });
    expectHealthyRun(r, { methodIds: methods, items: commentIds.length });
    for (const m of r.methods) {
      expect(Array.isArray(m.summary.topics), m.methodId).toBe(true);
      expect(m.summary.topics.length).toBeGreaterThan(0);
      expect(Array.isArray(m.summary.coherence)).toBe(true);
    }
  });

  test('topics: LDA is reproducible with a fixed seed', async () => {
    const body = { task: 'topics', target: 'comments', methods: ['lda'], ids: commentIds, options: { numTopics: 3, seed: 7 } };
    const a = await api.analyze(body);
    const b = await api.analyze(body);
    expect(a.methods[0].results.map((x) => x.label)).toEqual(b.methods[0].results.map((x) => x.label));
  });

  test('target stance: lexicon method needs and uses a target', async () => {
    const methods = methodsOf('target_stance', ['lexicon']);
    const missing = await api.post('/api/analyze', { task: 'target_stance', target: 'comments', methods, ids: commentIds.slice(0, 3) });
    if (missing.status === 202) {
      await expect(api.waitForJob(missing.body.jobId)).rejects.toThrow();
    } else {
      expect(missing.status).toBe(400);
    }
    const r = await api.analyze({ task: 'target_stance', target: 'comments', methods, ids: commentIds.slice(0, 10), options: { target: 'artificial intelligence' } });
    for (const m of r.methods) expect(m.status, m.error).not.toBe('failed');
  });
});

test.describe('Hugging Face methods', () => {
  test.skip(() => env.skipHF, 'E2E_SKIP_HF=1');

  test.beforeEach(() => {
    test.skip(!cfg.huggingface, 'HF_TOKEN is not configured on the server');
  });

  const ids = () => commentIds.slice(0, 2);

  test('sentiment: transformer models', async () => {
    const methods = methodsOf('sentiment', ['transformer']);
    const r = await api.analyze({ task: 'sentiment', target: 'comments', methods, ids: ids() });
    expectHealthyRun(r, { methodIds: methods, items: 2 });
  });

  test('emotion: emotion model', async () => {
    const r = await api.analyze({ task: 'emotion', target: 'comments', methods: ['hf-emotion'], ids: ids() });
    expectHealthyRun(r, { methodIds: ['hf-emotion'], items: 2 });
  });

  test('stance: zero-shot', async () => {
    const r = await api.analyze({ task: 'stance', target: 'comments', methods: ['hf-zero-shot'], ids: ids() });
    for (const m of r.methods) expect(m.status, m.error || JSON.stringify(m.results)).not.toBe('failed');
  });

  test('codebook: zero-shot with a custom codebook', async () => {
    const r = await api.analyze({
      task: 'codebook', target: 'comments', methods: ['hf-zero-shot'], ids: ids(),
      options: { codebook: 'economy: jobs and money\ntechnology: computers and AI\npolitics: government and elections' },
    });
    expectHealthyRun(r, { methodIds: ['hf-zero-shot'], items: 2 });
    for (const x of r.methods[0].results) if (x.label) expect(['economy', 'technology', 'politics']).toContain(x.label);
  });
});

test.describe('OpenAI methods', () => {
  test.skip(() => !env.runOpenAI, 'Set E2E_OPENAI=1 to test OpenAI (uses paid credits)');

  test('sentiment and summary with OpenAI', async () => {
    test.skip(!cfg.openai, 'OPENAI_API_KEY is not configured on the server');
    const r = await api.analyze({ task: 'sentiment', target: 'comments', methods: ['openai'], ids: commentIds.slice(0, 2) });
    expectHealthyRun(r, { methodIds: ['openai'], items: 2 });
    const s = await api.post('/api/corpus/summarize', { target: 'comments', ids: commentIds.slice(0, 5) });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
  });
});

test.describe('Saved runs, results and review', () => {
  test('save a run to a project, browse it, review a result and delete it', async () => {
    const project = await api.post('/api/projects', {
      name: 'E2E saved-run project', config: { keywords: 'AI', sources: ['*'], target: 'comments' },
    });
    expect(project.status).toBe(201);
    const projectId = project.body.id;

    const r = await api.analyze({
      task: 'sentiment', target: 'comments', methods: ['afinn', 'vader'], ids: commentIds.slice(0, 5), save: true, projectId,
    });
    for (const m of r.methods) {
      expect(m.saveError, m.saveError).toBeFalsy();
      expect(m.runId).toBeTruthy();
    }

    const runs = await api.get(`/api/runs?projectId=${projectId}`);
    expect(runs.status).toBe(200);
    expect(runs.body.map((x) => x.id).sort()).toEqual(r.methods.map((m) => m.runId).sort());

    const one = await api.get(`/api/runs/${r.methods[0].runId}`);
    expect(one.status).toBe(200);
    expect(one.body.run.project_id).toBe(projectId);
    expect(one.body.result.items).toHaveLength(5);

    const results = await api.get(`/api/results?task=sentiment&target=comments&projectId=${projectId}`);
    expect(results.status).toBe(200);
    expect(results.body.total).toBe(10);
    const row = results.body.rows.find((x) => x.label);
    expect(row).toBeTruthy();

    const summary = await api.get(`/api/results/summary?task=sentiment&target=comments&projectId=${projectId}`);
    expect(summary.status).toBe(200);
    expect(summary.body.total).toBe(10);

    const bad = await api.post('/api/validations', { task: 'sentiment', resultId: row.id, decision: 'correct' });
    expect(bad.status).toBe(400);

    const ok = await api.post('/api/validations', { task: 'sentiment', resultId: row.id, decision: 'correct', correctedLabel: 'neutral', note: 'e2e' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const history = await api.get(`/api/validations?task=sentiment&resultId=${row.id}`);
    expect(history.body.length).toBeGreaterThan(0);

    const approved = await api.get(`/api/results?task=sentiment&target=comments&projectId=${projectId}&decision=correct`);
    expect(approved.body.rows.map((x) => x.id)).toContain(row.id);

    for (const m of r.methods) expect((await api.del(`/api/runs/${m.runId}`)).status).toBe(200);
    expect((await api.get(`/api/runs?projectId=${projectId}`)).body).toHaveLength(0);
    await api.del(`/api/projects/${projectId}`);
  });

  test('another user cannot see my project', async () => {
    const project = await api.post('/api/projects', { name: 'E2E private', config: { keywords: 'AI', sources: ['*'] } });
    const other = await createTestUser('other');
    try {
      const otherApi = apiClient(await signIn(other.email, other.password));
      expect((await otherApi.get(`/api/projects/${project.body.id}`)).status).toBe(404);
      const r = await otherApi.post('/api/analyze', { task: 'sentiment', target: 'comments', methods: ['afinn'], ids: [commentIds[0]], projectId: project.body.id });
      expect(r.status).toBe(403);
    } finally {
      await deleteTestUser(other.id);
      await api.del(`/api/projects/${project.body.id}`);
    }
  });
});

test.describe('Corpus tools', () => {
  test('keywords returns ranked terms', async () => {
    const r = await api.post('/api/corpus/keywords', { target: 'comments', ids: commentIds });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const list = r.body.keywords || r.body.terms || r.body;
    expect(JSON.stringify(list).length).toBeGreaterThan(10);
  });

  test('concordance finds a term in context', async () => {
    const r = await api.post('/api/corpus/concordance', { target: 'comments', ids: commentIds, term: 'the' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.documents).toBe(commentIds.length);
    expect(r.body.docsWithHits).toBeGreaterThan(0);
    expect(r.body.lines.length).toBeGreaterThan(0);
  });
});
