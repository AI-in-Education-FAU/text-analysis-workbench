import { test, expect } from '@playwright/test';
import { randomPassword, testUser, uniqueEmail } from '../helpers.js';
import { uiLogin } from '../ui.js';

test.describe('Public pages (signed out)', () => {
  test('login page renders', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create an account' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Forgot password?' })).toBeVisible();
  });

  test('deep links load the app instead of a 404 (SPA redirect)', async ({ page }) => {
    const res = await page.goto('/runs');
    expect(res.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  test('dark theme toggle switches and is remembered after reload', async ({ page }) => {
    await page.goto('/');
    const html = page.locator('html');
    const start = (await html.getAttribute('data-theme')) || 'light';
    const other = start === 'dark' ? 'light' : 'dark';
    await page.getByRole('button', { name: /theme/i }).click();
    await expect(html).toHaveAttribute('data-theme', other);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', other);
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(bg);
    await page.getByRole('button', { name: /theme/i }).click();
    await expect(html).toHaveAttribute('data-theme', start);
  });

  test('a wrong password shows a friendly error', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Email').fill(testUser().email);
    await page.getByLabel('Password').fill('definitely-wrong-password');
    await page.getByLabel('Password').press('Enter');
    await expect(page.locator('.alert.error')).toContainText('Incorrect email or password');
  });

  test('forgot-password form switches modes', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Forgot password?' }).click();
    await expect(page.getByRole('heading', { name: 'Reset password' })).toBeVisible();
    await expect(page.getByLabel('Password')).toHaveCount(0);
    await page.getByRole('button', { name: 'Back to sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  test('a new researcher can create an account and sign out', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create an account' }).click();
    await expect(page.getByRole('heading', { name: 'Create account' })).toBeVisible();
    const email = uniqueEmail('signup');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(randomPassword());
    await page.getByLabel('Password').press('Enter');
    // Email auto-confirm is on, so sign-up signs the user straight in.
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.user-box')).toContainText(email);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  test('an existing user can sign in and the session survives a reload', async ({ page }) => {
    await uiLogin(page, testUser());
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible({ timeout: 60_000 });
  });
});
