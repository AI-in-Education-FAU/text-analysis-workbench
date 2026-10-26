import { deleteAllTestUsers } from './helpers.js';

export default async function globalTeardown() {
  const removed = await deleteAllTestUsers();
  console.log(`\nCleaned up ${removed.length} test user(s) and their projects, runs and results`);
}
