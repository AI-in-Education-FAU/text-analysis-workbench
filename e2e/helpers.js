import { env, TEST_EMAIL_DOMAIN, TEST_EMAIL_PREFIX } from './env.js';

export { env };

const json = async (res) => {
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { return text; }
};

async function call(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, ok: res.ok, body: await json(res) };
}

function requireServiceKey() {
  if (!env.serviceKey) {
    throw new Error('E2E_SUPABASE_SERVICE_ROLE_KEY is not set. Copy e2e/.env.example to e2e/.env and fill it in.');
  }
}

const adminHeaders = () => {
  requireServiceKey();
  return { apikey: env.serviceKey, Authorization: `Bearer ${env.serviceKey}` };
};

export const uniqueEmail = (tag = 'user') =>
  `${TEST_EMAIL_PREFIX}${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}${TEST_EMAIL_DOMAIN}`;

export const randomPassword = () => `E2e!${Math.random().toString(36).slice(2, 10)}Aa9`;

/** Creates an already-confirmed Supabase Auth user. */
export async function createTestUser(tag = 'user') {
  const email = uniqueEmail(tag);
  const password = randomPassword();
  const r = await call(`${env.supabaseURL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: adminHeaders(),
    body: { email, password, email_confirm: true },
  });
  if (!r.ok) throw new Error(`Could not create test user (${r.status}): ${JSON.stringify(r.body)}`);
  return { id: r.body.id, email, password };
}

/** Removes everything a test user created, then the user (projects cascade with the user). */
export async function deleteTestUser(id) {
  const h = adminHeaders();
  await call(`${env.supabaseURL}/rest/v1/analysis_runs?created_by=eq.${id}`, { method: 'DELETE', headers: h });
  await call(`${env.supabaseURL}/rest/v1/projects?owner_id=eq.${id}`, { method: 'DELETE', headers: h });
  const r = await call(`${env.supabaseURL}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: h });
  if (!r.ok && r.status !== 404) throw new Error(`Could not delete test user ${id} (${r.status}): ${JSON.stringify(r.body)}`);
}

/** Deletes every leftover e2e-*@example.com user (e.g. from the UI sign-up test or an aborted run). */
export async function deleteAllTestUsers() {
  const h = adminHeaders();
  const removed = [];
  for (let page = 1; page < 50; page++) {
    const r = await call(`${env.supabaseURL}/auth/v1/admin/users?page=${page}&per_page=200`, { headers: h });
    const users = r.body?.users || [];
    for (const u of users) {
      if (u.email?.startsWith(TEST_EMAIL_PREFIX) && u.email.endsWith(TEST_EMAIL_DOMAIN)) {
        await deleteTestUser(u.id);
        removed.push(u.email);
      }
    }
    if (users.length < 200) break;
  }
  return removed;
}

export async function signIn(email, password) {
  const r = await call(`${env.supabaseURL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: env.publishableKey },
    body: { email, password },
  });
  if (!r.ok) throw new Error(`Sign-in failed (${r.status}): ${JSON.stringify(r.body)}`);
  return r.body.access_token;
}

/** Waits for the analysis API (Render free instances sleep and take ~1 min to wake). */
export async function warmUpApi(timeoutMs = 180_000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await call(`${env.apiURL}/api/config`);
      if (r.ok) return r.body;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = e.message;
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
  throw new Error(`Analysis API at ${env.apiURL} did not respond in time (${last})`);
}

/** Small authenticated client for the analysis API. */
export function apiClient(token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const req = (method, path, body) => call(`${env.apiURL}${path}`, { method, headers, body });
  return {
    get: (p) => req('GET', p),
    post: (p, b) => req('POST', p, b ?? {}),
    put: (p, b) => req('PUT', p, b ?? {}),
    del: (p) => req('DELETE', p),
    async analyze(body, timeoutMs = 240_000) {
      const start = await req('POST', '/api/analyze', body);
      if (start.status !== 202) throw new Error(`analyze returned ${start.status}: ${JSON.stringify(start.body)}`);
      return this.waitForJob(start.body.jobId, timeoutMs);
    },
    async waitForJob(jobId, timeoutMs = 240_000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const r = await req('GET', `/api/jobs/${jobId}`);
        if (r.status !== 200) throw new Error(`job ${jobId} returned ${r.status}: ${JSON.stringify(r.body)}`);
        if (r.body.status === 'done') return r.body.result;
        if (r.body.status === 'error') throw new Error(`job failed: ${r.body.error}`);
        await new Promise((res) => setTimeout(res, 1000));
      }
      throw new Error(`job ${jobId} did not finish within ${timeoutMs} ms`);
    },
  };
}

/** Reads ids straight from Supabase as the signed-in user (same access the website has). */
export async function sampleIds(token, table, limit) {
  const r = await call(`${env.supabaseURL}/rest/v1/${table}?select=id&order=id.asc&limit=${limit}`, {
    headers: { apikey: env.publishableKey, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Could not read ${table} (${r.status}): ${JSON.stringify(r.body)}`);
  return r.body.map((x) => x.id);
}

export async function countRows(table, filter) {
  const res = await fetch(`${env.supabaseURL}/rest/v1/${table}?select=id&${filter}`, {
    headers: { ...adminHeaders(), Prefer: 'count=exact', Range: '0-0' },
  });
  return Number((res.headers.get('content-range') || '*/0').split('/')[1]);
}

export function testUser() {
  const { E2E_USER_EMAIL: email, E2E_USER_PASSWORD: password, E2E_USER_ID: id } = process.env;
  if (!email || !password) throw new Error('Test user missing – global-setup.js did not run');
  return { email, password, id };
}
