import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

let client = null;

export function supabaseConfigured() {
  return Boolean(config.supabaseUrl && config.supabaseKey);
}

export function db() {
  if (!supabaseConfigured()) {
    const err = new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in server/.env');
    err.status = 503;
    throw err;
  }
  if (!client) {
    client = createClient(config.supabaseUrl, config.supabaseKey, { auth: { persistSession: false } });
  }
  return client;
}

export function check({ data, error, count }) {
  if (error) {
    const err = new Error(error.message || 'Database error');
    err.status = 500;
    err.details = error;
    throw err;
  }
  return count === undefined || count === null ? data : { data, count };
}
