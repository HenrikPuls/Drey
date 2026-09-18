import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect, type Locator, type Page } from './fixtures/drey';

/**
 * Real drag-and-drop for editor tabs (ADR-0039): the source stays put
 * during the drag, a `.tab-drag-ghost` chip + a `.drop-line` show what
 * would happen, an invalid target shows `no-drop`, and the move commits
 * once on release.
 *
 * The seeded vault opens today's daily note on startup, so these tests
 * only ever assert on the `a.md` / `b.md` tabs they create, never the full
 * tab list.
 */

async function open(page: Page, vaultDir: string, name: string): Promise<void> {
  fs.writeFileSync(path.join(vaultDir, name), `# ${name}\n\nbody of ${name}\n`);
  await page.locator('app-dock[side="left"] .hdr-btn[aria-label="Refresh files"]').click();
  await page.locator('app-dock[side="left"] .node.file', { hasText: name }).click();
}

/**
 * Opens two files side by side in one strip. Sequential clicks keep only
 * the last file any more -- `openFile` replaces the focused clean tab
 * (milestone 32) -- so both rows are selected (Ctrl+click) and opened in
 * one Enter: `openSelection` replaces only on its first call, so both tabs
 * survive.
 */
async function openTwo(page: Page, vaultDir: string, first: string, second: string): Promise<void> {
  await open(page, vaultDir, first); // replaces the startup daily tab
  fs.writeFileSync(path.join(vaultDir, second), `# ${second}\n\nbody of ${second}\n`);
  await page.locator('app-dock[side="left"] .hdr-btn[aria-label="Refresh files"]').click();
  await page
    .locator('app-dock[side="left"] .node.file', { hasText: second })
    .click({ modifiers: ['ControlOrMeta'] });
  await page.keyboard.press('Enter');
  await expect(tab(page, first)).toHaveCount(1);
  await expect(tab(page, second)).toHaveCount(1);
}

async function centre(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error('locator has no bounding box');
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Order of the a.md / b.md tabs across every pane (daily note filtered out). */
async function abOrder(page: Page): Promise<string[]> {
  const names = await page.locator('app-tab-bar .tab .name').allInnerTexts();
  return names.map((n) => n.trim()).filter((n) => n === 'a.md' || n === 'b.md');
}

const tab = (page: Page, name: string): Locator =>
  page.locator('app-tab-bar .tab', { hasText: name });

test.describe('tab drag-and-drop', () => {
  test('reorder within a pane commits only on drop', async ({ page, vaultDir }) => {
    await openTwo(page, vaultDir, 'a.md', 'b.md');
    expect(await abOrder(page)).toEqual(['a.md', 'b.md']);

    const from = await centre(tab(page, 'a.md'));
    const to = await centre(tab(page, 'b.md'));

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x + 20, to.y, { steps: 10 });

    // Mid-drag: source dimmed but not moved, ghost + drop-line visible.
    await expect(page.locator('app-tab-bar .tab.dragging')).toHaveCount(1);
    await expect(page.locator('body > .tab-drag-ghost')).toContainText('a.md');
    await expect(page.locator('app-tab-bar .drop-line')).toHaveCount(1);
    await expect(page.locator('body > .drag-overlay')).toHaveCount(1);
    expect(await abOrder(page)).toEqual(['a.md', 'b.md']); // deferred

    await page.mouse.up();

    // The commit happens on release; under a loaded machine the render can
    // lag the mouse-up, so poll instead of reading the DOM exactly once.
    await expect
      .poll(() => abOrder(page))
      .toEqual(['b.md', 'a.md']); // committed
    await expect(page.locator('body > .drag-overlay')).toHaveCount(0);
    await expect(page.locator('app-tab-bar .drop-line')).toHaveCount(0);
  });

  test('dropping on a non-pane area is a no-op (no-drop)', async ({ page, vaultDir }) => {
    await openTwo(page, vaultDir, 'a.md', 'b.md');

    const from = await centre(tab(page, 'a.md'));
    const dock = await centre(page.locator('app-dock[side="left"]'));

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(dock.x, dock.y, { steps: 10 });

    expect(await page.evaluate(() => getComputedStyle(document.body).cursor)).toBe('no-drop');
    await expect(page.locator('app-tab-bar .drop-line')).toHaveCount(0);

    await page.mouse.up();
    expect(await abOrder(page)).toEqual(['a.md', 'b.md']); // unchanged
  });

  test('dropping onto another pane’s body moves the tab there', async ({ page, vaultDir }) => {
    await openTwo(page, vaultDir, 'a.md', 'b.md'); // b.md active
    await page.locator('app-editor .cm-content').first().click();
    await page.keyboard.press('Control+Alt+Enter'); // split right: b.md moves into pane 2
    await expect(page.locator('app-editor')).toHaveCount(2);
    await expect(tab(page, 'b.md')).toHaveCount(1);

    // a.md and b.md start in different panes.
    const strips = page.locator('app-tab-bar');
    const stripWithA = strips.filter({ has: page.locator('.tab', { hasText: 'a.md' }) });
    await expect(stripWithA.locator('.tab', { hasText: 'b.md' })).toHaveCount(0);

    // Drag a.md onto pane 2's editor body.
    const from = await centre(tab(page, 'a.md'));
    const paneTwoBody = await centre(page.locator('app-editor .cm-content').nth(1));

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(paneTwoBody.x, paneTwoBody.y, { steps: 12 });
    await expect(page.locator('app-pane-leaf.drop-target')).toHaveCount(1);
    await page.mouse.up();

    // a.md and b.md now share a strip.
    const stripWithB = page
      .locator('app-tab-bar')
      .filter({ has: page.locator('.tab', { hasText: 'b.md' }) });
    await expect(stripWithB.locator('.tab', { hasText: 'a.md' })).toHaveCount(1);
  });
});
