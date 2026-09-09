import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect, type Page } from './fixtures/drey';

/**
 * A vault file dropped onto a pane but not into `.cm-content` (the tab
 * strip, meta bar, empty state, the padding around the text) opens as a tab
 * in that pane -- `PaneDropService`, amending the ADR-0027 window drop
 * guard. A drop on `.cm-content` itself is still CodeMirror's (ADR-0028,
 * covered by `image-drag.spec.ts`).
 */

async function refresh(page: Page): Promise<void> {
  await page.locator('app-dock[side="left"] .icon-btn.refresh').click();
}

/** Fire a real `DataTransfer`-carrying dragover + drop on `selector`. */
async function dropVaultPath(page: Page, selector: string, relPath: string): Promise<void> {
  await page.evaluate(
    ({ selector, relPath }: { selector: string; relPath: string }) => {
      const target = document.querySelector(selector);
      if (!target) {
        throw new Error(`no element for ${selector}`);
      }
      const dt = new DataTransfer();
      dt.setData('application/x-drey-vault-path', relPath);
      for (const name of ['dragover', 'drop'] as const) {
        const event = new DragEvent(name, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: dt });
        target.dispatchEvent(event);
      }
    },
    { selector, relPath },
  );
}

test.describe('drop a file onto a pane to open it', () => {
  test('dropped on the tab strip, the file opens as the active tab', async ({ page, vaultDir }) => {
    fs.writeFileSync(path.join(vaultDir, 'a.md'), '# a\n\nbody a\n');
    fs.writeFileSync(path.join(vaultDir, 'dropped.md'), '# dropped\n\nhello from dropped\n');
    await refresh(page);
    await page.locator('app-dock[side="left"] .node.file', { hasText: 'a.md' }).click();
    await expect(page.locator('app-editor .cm-content')).toBeVisible();

    await expect(page.locator('app-tab-bar .tab', { hasText: 'dropped.md' })).toHaveCount(0);

    await dropVaultPath(page, 'app-tab-bar', 'dropped.md');

    const droppedTab = page.locator('app-tab-bar .tab', { hasText: 'dropped.md' });
    await expect(droppedTab).toHaveCount(1);
    await expect(droppedTab).toHaveClass(/active/);
    await expect(page.locator('app-editor .cm-content')).toContainText('hello from dropped');
  });

  test('dropped on a second pane’s body, the file opens in that pane', async ({ page, vaultDir }) => {
    fs.writeFileSync(path.join(vaultDir, 'a.md'), '# a\n\nbody a\n');
    fs.writeFileSync(path.join(vaultDir, 'b.md'), '# b\n\nbody b\n');
    fs.writeFileSync(path.join(vaultDir, 'side.md'), '# side\n\nside note\n');
    await refresh(page);
    await page.locator('app-dock[side="left"] .node.file', { hasText: 'a.md' }).click();
    await page.locator('app-dock[side="left"] .node.file', { hasText: 'b.md' }).click();

    await page.locator('app-editor .cm-content').first().click();
    await page.keyboard.press('Control+Alt+Enter'); // split right: b.md -> pane 2
    await expect(page.locator('app-editor')).toHaveCount(2);

    // Drop side.md on pane 1's leaf (its body, away from .cm-content).
    await dropVaultPath(page, 'app-pane-leaf', 'side.md');

    const paneOne = page.locator('app-pane-leaf').first();
    await expect(paneOne.locator('app-tab-bar .tab', { hasText: 'side.md' })).toHaveCount(1);
    // The other pane did not get it.
    const paneTwo = page.locator('app-pane-leaf').nth(1);
    await expect(paneTwo.locator('app-tab-bar .tab', { hasText: 'side.md' })).toHaveCount(0);
  });
});
