import { expect } from '@playwright/test';

/** Signs in through the real login form. */
export async function uiLogin(page, { email, password }) {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  // Enter is more reliable than clicking while the form re-renders.
  await page.getByLabel('Password').press('Enter');
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible({ timeout: 60_000 });
}

export async function goNav(page, label) {
  await page.locator('aside.sidebar nav').getByRole('link', { name: label, exact: true }).click();
}

/** Accept every window.confirm() (used by the Delete buttons). */
export function autoAcceptDialogs(page) {
  page.on('dialog', (d) => d.accept());
}
