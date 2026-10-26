import { createTestUser, deleteAllTestUsers, env, warmUpApi } from './helpers.js';

export default async function globalSetup() {
  console.log(`\nE2E target  website: ${env.baseURL}\n            API:     ${env.apiURL}`);
  // Remove anything left behind by a previous aborted run.
  const stale = await deleteAllTestUsers();
  if (stale.length) console.log(`Removed ${stale.length} leftover test user(s)`);

  const cfg = await warmUpApi();
  console.log(`API is up (supabase=${cfg.supabase}, huggingface=${cfg.huggingface}, openai=${cfg.openai})`);

  const user = await createTestUser('main');
  process.env.E2E_USER_EMAIL = user.email;
  process.env.E2E_USER_PASSWORD = user.password;
  process.env.E2E_USER_ID = user.id;
}
