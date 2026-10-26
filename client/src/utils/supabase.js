import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const supabaseConfigured = Boolean(supabaseUrl && supabaseKey);

if (!supabaseConfigured) {
  console.error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY at build time');
}

// Placeholder values keep module loading from crashing; main.jsx shows a setup message instead.
export const supabase = createClient(supabaseUrl || 'http://localhost', supabaseKey || 'missing-key');
