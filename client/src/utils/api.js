import { supabase } from './supabase';

const BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

async function authHeader() {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}/api${path}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await authHeader()) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Cannot reach the analysis server. Is it running (npm run dev in /server)?');
  }
  if (!(res.headers.get('content-type') || '').includes('application/json')) {
    throw new Error(BASE
      ? `The analysis server at ${BASE} returned an unexpected response (${res.status}).`
      : 'The analysis server is not configured for this site. Set VITE_API_URL to the API URL and rebuild.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.fields = data.fields;
    throw err;
  }
  return data;
}

const qs = (params = {}) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  return s ? `?${s}` : '';
};

export const api = {
  config: () => request('/config'),

  projects: () => request('/projects'),
  project: (id) => request(`/projects/${id}`),
  createProject: (body) => request('/projects', { method: 'POST', body }),
  updateProject: (id, body) => request(`/projects/${id}`, { method: 'PUT', body }),
  deleteProject: (id) => request(`/projects/${id}`, { method: 'DELETE' }),

  analyze: (body) => request('/analyze', { method: 'POST', body }),
  job: (id) => request(`/jobs/${id}`),
  retryJob: (id) => request(`/jobs/${id}/retry`, { method: 'POST' }),

  keywords: (body) => request('/corpus/keywords', { method: 'POST', body }),
  concordance: (body) => request('/corpus/concordance', { method: 'POST', body }),
  summarize: (body) => request('/corpus/summarize', { method: 'POST', body }),

  runs: (params = {}) => request(`/runs${qs(typeof params === 'string' ? { task: params } : params)}`),
  run: (id) => request(`/runs/${id}`),
  retryRun: (id) => request(`/runs/${id}/retry`, { method: 'POST' }),
  deleteRun: (id) => request(`/runs/${id}`, { method: 'DELETE' }),

  results: (params) => request(`/results${qs(params)}`),
  resultsSummary: (params) => request(`/results/summary${qs(params)}`),
  validate: (body) => request('/validations', { method: 'POST', body }),
  validationHistory: (task, resultId) => request(`/validations${qs({ task, resultId })}`),

  referenceLabels: (params) => request(`/reference-labels${qs(params)}`),
  saveReferenceLabels: (body) => request('/reference-labels', { method: 'POST', body }),
  deleteReferenceLabel: (id) => request(`/reference-labels/${id}`, { method: 'DELETE' }),
};

/** Polls a background job until it finishes. Returns a stop function. */
export function pollJob(id, onUpdate, onError, interval = 1000) {
  const timer = setInterval(async () => {
    try {
      const j = await api.job(id);
      onUpdate(j);
      if (j.status === 'done' || j.status === 'error') clearInterval(timer);
    } catch (e) {
      clearInterval(timer);
      onError?.(e);
    }
  }, interval);
  return () => clearInterval(timer);
}
