import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(here, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const strip = (u) => u.replace(/\/+$/, '');

export const env = {
  baseURL: strip(process.env.E2E_BASE_URL || 'https://warm-mousse-9e6c33.netlify.app'),
  apiURL: strip(process.env.E2E_API_URL || 'https://nlp-workbench-api.onrender.com'),
  supabaseURL: strip(process.env.E2E_SUPABASE_URL || 'https://lxmpqprsopkdnfwanddr.supabase.co'),
  // Public (browser) key – safe to ship.
  publishableKey: process.env.E2E_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_Ii9sjoecCgxyMejocySEqw_TNuexqbI',
  serviceKey: process.env.E2E_SUPABASE_SERVICE_ROLE_KEY || '',
  runOpenAI: process.env.E2E_OPENAI === '1',
  skipHF: process.env.E2E_SKIP_HF === '1',
};

export const TEST_EMAIL_PREFIX = 'e2e-';
export const TEST_EMAIL_DOMAIN = '@example.com';
