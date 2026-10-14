import { test, expect } from './fixtures/drey';

/**
 * bug-11: a link inside a rendered table (markdown-it HTML, a real
 * `<a href>`) used to navigate the whole window to the dev server /
 * `app://` path — "Cannot GET /…", no titlebar, no way to quit. A click
 * now opens the linked note in a tab, and the app stays.
 */

const INDEX = [
  '# Index',
  '',
  '| Id | Decision |',
  '| --- | --- |',
  '| [0052](decisions/0052-pdf-embeds.md) | PDF embeds |',
  '',
].join('\n');

const ADR = ['# 0052 — PDF embeds', '', 'The decision text.', ''].join('\n');

test.use({ seedVault: { 'index.md': INDEX, 'decisions/0052-pdf-embeds.md': ADR } });

test('a link in a rendered table opens the note instead of navigating the window', async ({
  page,
}) => {
  await page.locator('app-dock[side="left"] .node.file', { hasText: 'index.md' }).click();
  const link = page.locator('app-editor .lp-table a', { hasText: '0052' });
  await expect(link).toBeVisible();

  const before = page.url();
  await link.click();

  await expect(page.locator('app-tab-bar .tab', { hasText: '0052-pdf-embeds' })).toBeVisible();
  await expect(page.locator('app-editor .cm-content')).toContainText('The decision text.');
  expect(page.url()).toBe(before);
  await expect(page.locator('app-titlebar')).toBeVisible();
});
