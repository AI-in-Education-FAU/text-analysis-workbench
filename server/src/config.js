import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 3001),
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  supabaseUrl: process.env.SUPABASE_URL,
  // Service-role key stays on the server only; it is needed to write analysis results.
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY,
  openaiKey: process.env.OPENAI_API_KEY,
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  hfToken: process.env.HF_TOKEN,
  hfBaseUrl: process.env.HF_BASE_URL || 'https://router.huggingface.co/hf-inference/models',
  maxItemsPerRun: Number(process.env.MAX_ITEMS_PER_RUN || 500),
  authDisabled: process.env.AUTH_DISABLED === 'true',
  clientDist: process.env.CLIENT_DIST,
};

export const providers = {
  openai: () => Boolean(config.openaiKey),
  huggingface: () => Boolean(config.hfToken),
};
