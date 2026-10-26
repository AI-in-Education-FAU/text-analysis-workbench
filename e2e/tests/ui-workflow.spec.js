import { test, expect } from '@playwright/test';
import { testUser } from '../helpers.js';
import { autoAcceptDialogs, goNav, uiLogin } from '../ui.js';

/**
 * The full researcher workflow in the real website, one step after another:
 * dashboard → create project → explore & select → analyze → saved runs → review → corpus tools → cleanup.
 */
test.describe.configure({ mode: 'serial' });

const PROJECT = `E2E UI project ${Date.now()}`;
let page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  autoAcceptDialogs(page);
  await uiLogin(page, testUser());
});

test.afterAll(async () => {
  await page?.close();
});

test('dashboard shows data counts and connected services', async () => {
  const stat = (label) => page.locator('.stat', { has: page.locator('.label', { hasText: new RegExp(`^${label}$`) }) }).locator('.value');
  await expect(stat('Articles')).toHaveText(/^[1-9][\d,]*$/);
  await expect(stat('Comments')).toHaveText(/^[1-9][\d,]*$/);
  await expect(page.getByText('● connected').first()).toBeVisible();
  await expect(page.locator('main .alert.error')).toHaveCount(0);
});

test('projects: validation errors, then create a project', async () => {
  await goNav(page, 'Projects');
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'New project' }).click();

  await page.getByRole('button', { name: 'Save project' }).click();
  await expect(page.locator('form .alert.error')).toContainText('Please fix the project settings');
  await expect(page.getByText('Project name is required', { exact: true })).toBeVisible();

  await page.getByLabel('Name *').fill(PROJECT);
  await page.getByLabel('Description').fill('Created by the Playwright e2e suite');
  await page.getByLabel('Keywords').fill('AI');
  await page.getByLabel('Default unit of analysis').selectOption('comments');
  await page.getByRole('button', { name: 'Save project' }).click();

  const row = page.locator('main tbody tr', { hasText: PROJECT });
  await expect(row).toBeVisible();
  await expect(row.locator('input[type=radio]')).toBeChecked();
  await expect(page.locator('.project-picker select')).toHaveValue(/\d+/);
});

test('projects: edit the project', async () => {
  const row = page.locator('main tbody tr', { hasText: PROJECT });
  await row.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Description').fill('Edited by the e2e suite');
  await page.getByRole('button', { name: 'Save project' }).click();
  await expect(page.locator('main tbody tr', { hasText: PROJECT })).toContainText('Edited by the e2e suite');
});

test('explore: the project scopes the data and items can be selected', async () => {
  await page.locator('main tbody tr', { hasText: PROJECT }).getByRole('button', { name: 'Explore' }).click();
  await expect(page.getByRole('heading', { name: 'Explore data', level: 1 })).toBeVisible();
  await expect(page.getByText(`Restrict to project ${PROJECT}`)).toBeVisible();

  await page.locator('.tabs').getByRole('button', { name: 'Comments' }).click();
  const boxes = page.locator('main tbody input[type=checkbox]');
  await expect(boxes.first()).toBeVisible({ timeout: 60_000 });
  expect(await boxes.count()).toBeGreaterThan(2);
  for (let i = 0; i < 3; i++) await boxes.nth(i).check();

  const go = page.getByRole('button', { name: 'Analyze 3 selected →' });
  await expect(go).toBeEnabled();
  await go.click();
  await expect(page.getByRole('heading', { name: 'Analyze', level: 1 })).toBeVisible();
  await expect(page.locator('.sel-badge')).toContainText('3 comments selected');
});

test('analyze: run AFINN + VADER sentiment, save it, and see results and charts', async () => {
  const sentimentCard = page.locator('button.task-card', { hasText: 'Sentiment' });
  await sentimentCard.click();
  await expect(sentimentCard).toHaveClass(/active/);
  const afinn = page.locator('label.method', { hasText: 'AFINN' }).locator('input');
  const vader = page.locator('label.method', { hasText: 'VADER' }).locator('input');
  // The page pre-selects the first local method; wait for that before toggling others.
  await expect(afinn).toBeChecked();
  await vader.check();
  await page.getByLabel('Save results to Supabase').check();

  await page.getByRole('button', { name: 'Run analysis' }).click();
  await expect(page.getByRole('heading', { name: 'Results', level: 2 })).toBeVisible({ timeout: 120_000 });

  const statusTags = page.locator('main td .tag[class*="status-"]');
  await expect(statusTags).toHaveCount(2);
  for (const t of await statusTags.all()) await expect(t).toHaveText(/completed|partial/);
  await expect(page.getByRole('link', { name: 'saved ✓' })).toHaveCount(2);
  await expect(page.getByRole('heading', { name: 'Label distribution' })).toBeVisible();
  await expect(page.locator('.recharts-surface').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Item-level results' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Agreement between methods' })).toBeVisible();
});

test('analyze: run LDA topic modelling without saving', async () => {
  const topicsCard = page.locator('button.task-card', { hasText: 'Topic' });
  await topicsCard.click();
  await expect(topicsCard).toHaveClass(/active/);
  await expect(page.locator('label.method', { hasText: 'LDA' }).locator('input')).toBeChecked();
  const save = page.getByLabel('Save results to Supabase');
  if (await save.isChecked()) await save.uncheck();
  await page.getByRole('button', { name: 'Run analysis' }).click();
  await expect(page.getByRole('heading', { name: 'Topics', level: 3 })).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('main td .tag[class*="status-"]').first()).toHaveText(/completed|partial/);
});

test('saved runs: both runs are listed and open in detail', async () => {
  await goNav(page, 'Saved runs');
  await expect(page.getByRole('heading', { name: 'Saved runs', level: 1 })).toBeVisible();
  const rows = page.locator('main tbody tr', { has: page.getByRole('button', { name: 'Delete' }) });
  await expect(rows).toHaveCount(2);
  await rows.first().getByRole('link').first().click();
  await expect(page.getByRole('heading', { name: 'Results', level: 2 })).toBeVisible({ timeout: 60_000 });
});

test('review: results are listed and a label can be approved', async () => {
  await goNav(page, '3 · Review & validate');
  await expect(page.getByRole('heading', { name: 'Review results', level: 1 })).toBeVisible();
  await page.getByLabel('Unit').selectOption('comments');
  await page.getByRole('button', { name: 'Apply' }).click();
  // 3 comments × 2 methods = 6 saved results, none reviewed yet.
  await expect(page.getByRole('button', { name: '6 unreviewed' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Approve' }).first().click();
  await expect(page.getByRole('button', { name: '1 approve' })).toBeVisible();
  await expect(page.getByRole('button', { name: '5 unreviewed' })).toBeVisible();

  await page.getByLabel('Review status').selectOption({ label: 'Approved' });
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('button', { name: 'history' })).toHaveCount(1);
});

test('corpus tools: keywords and concordance', async () => {
  await goNav(page, 'Corpus tools');
  await expect(page.getByRole('heading', { name: 'Corpus tools', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Compute keywords' }).click();
  await expect(page.getByRole('heading', { name: 'Most frequent terms' })).toBeVisible({ timeout: 60_000 });
  // Clicking a term opens the concordance (KWIC) tab for it.
  await page.locator('main table').first().locator('tbody button.link').first().click();
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('main tbody tr').first()).toBeVisible({ timeout: 60_000 });
});

test('method guide lists the methods', async () => {
  await goNav(page, 'Method guide');
  await expect(page.getByRole('heading', { name: 'Method guide', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'All available methods' })).toBeVisible();
  await expect(page.getByText('VADER').first()).toBeVisible();
});

test('dark theme works on signed-in pages', async () => {
  const html = page.locator('html');
  const start = (await html.getAttribute('data-theme')) || 'light';
  await page.locator('.user-box').getByRole('button', { name: /theme/i }).click();
  await expect(html).toHaveAttribute('data-theme', start === 'dark' ? 'light' : 'dark');
  await page.locator('.user-box').getByRole('button', { name: /theme/i }).click();
  await expect(html).toHaveAttribute('data-theme', start);
});

test('cleanup: delete the saved runs and the project', async () => {
  await goNav(page, 'Saved runs');
  const del = page.locator('main tbody').getByRole('button', { name: 'Delete' });
  await expect(del).toHaveCount(2);
  await del.first().click();
  await expect(del).toHaveCount(1);
  await del.first().click();
  await expect(del).toHaveCount(0);

  await goNav(page, 'Projects');
  const row = page.locator('main tbody tr', { hasText: PROJECT });
  await row.getByRole('button', { name: 'Delete' }).click();
  await expect(row).toHaveCount(0);
  await expect(page.getByText('No projects yet.')).toBeVisible();
});

test('sign out returns to the login page', async () => {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
