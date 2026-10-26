import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const supabaseConfigured = Boolean(supabaseUrl && supabaseKey);

if (!supabaseConfigured) {
  console.error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY at build time');
}

// A password-reset email link lands here with type=recovery in the URL. Capture it before
// the client consumes and strips the URL, because the PASSWORD_RECOVERY event can fire
// before React subscribes to auth changes.
export const openedFromRecoveryLink = typeof window !== 'undefined'
  && /(^|[#&?])type=recovery(&|$)/.test(window.location.hash + '&' + window.location.search.slice(1));

// Placeholder values keep module loading from crashing; main.jsx shows a setup message instead.
export const supabase = createClient(supabaseUrl || 'http://localhost', supabaseKey || 'missing-key');
