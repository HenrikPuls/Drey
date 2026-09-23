import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from './fixtures/drey';

/**
 * Files the OS hands to Drey (Explorer "Open with" / default program,
 * ADR-0054): a file inside a registered vault opens as an ordinary vault
 * tab; one outside every vault opens as a read-only, pinned external tab
 * that can never be written back.
 */

test.describe('a file passed on the command line, outside every vault', () => {
  test.use({
    launchFiles: [{ dir: 'external', name: 'outside.md', content: '# Outside\n\nbody outside\n' }],
  });

  test('opens as a pinned, editable tab marked as outside the vaults', async ({ page }) => {
    const tab = page.locator('app-tab-bar .tab', { hasText: 'outside.md' });
    await expect(tab).toHaveCount(1);
    await expect(tab.locator('.pin')).toHaveCount(1);
    await expect(page.locator('app-editor .cm-content')).toContainText('body outside');
    await expect(page.locator('app-editor .chrome .external-note')).toContainText('Outside your vaults');
    await expect(page.locator('app-editor .cm-content')).toHaveAttribute('contenteditable', 'true');
  });

  test('Ctrl+S saves the edit back to the original location', async ({ page, externalDir }) => {
    const target = path.join(externalDir, 'outside.md');

    await expect(page.locator('app-editor .cm-content')).toContainText('body outside');
    await page.locator('app-editor .cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('added line');
    await expect(page.locator('app-tab-bar .tab .dirty')).toHaveCount(1);

    await page.keyboard.press('Control+S');
    await expect(page.locator('app-tab-bar .tab .dirty')).toHaveCount(0);

    const saved = fs.readFileSync(target, 'utf-8');
    expect(saved).toContain('body outside');
    expect(saved).toContain('added line');
    // Nothing of the vault pipeline touched it: no frontmatter was injected.
    expect(saved.startsWith('# Outside')).toBe(true);
  });

  test('is never replaced when another file opens', async ({ page, vaultDir }) => {
    fs.writeFileSync(path.join(vaultDir, 'a.md'), '# a\n');
    await page.locator('app-dock[side="left"] .hdr-btn[aria-label="Refresh files"]').click();
    await page.locator('app-dock[side="left"] .node.file', { hasText: 'a.md' }).click();

    await expect(page.locator('app-tab-bar .tab', { hasText: 'a.md' })).toHaveCount(1);
    await expect(page.locator('app-tab-bar .tab', { hasText: 'outside.md' })).toHaveCount(1);
  });
});

test.describe('a file passed on the command line, inside the vault', () => {
  test.use({
    launchFiles: [{ dir: 'vault', name: 'inside.md', content: '# Inside\n\nbody inside\n' }],
  });

  test('opens as an ordinary, editable vault tab', async ({ page }) => {
    await expect(page.locator('app-tab-bar .tab', { hasText: 'inside.md' })).toHaveCount(1);
    await expect(page.locator('app-editor .cm-content')).toContainText('body inside');
    await expect(page.locator('app-editor .chrome .edit-lock')).toHaveCount(0);
    await expect(page.locator('app-editor .cm-content')).toHaveAttribute('contenteditable', 'true');
  });
});

test.describe('a second launch while Drey is running', () => {
  test('arrives in the same window as a new external tab', async ({ page, electronApp, externalDir }) => {
    // Let the startup daily note finish opening first -- it would otherwise
    // race the push for the focus.
    await expect(page.locator('app-tab-bar .tab')).toHaveCount(1);

    const late = path.join(externalDir, 'late.md');
    fs.writeFileSync(late, '# Late\n\nbody late\n');
    // What Electron emits when Explorer starts a second drey.exe:
    // (event, argv, cwd). Unpackaged (as under test) argv carries the app
    // path as entry 1, exactly like the launch itself.
    await electronApp.evaluate(
      ({ app }, args) => {
        app.emit('second-instance', {}, args.argv, args.cwd);
      },
      { argv: ['electron.exe', '.', late], cwd: externalDir },
    );

    await expect(page.locator('app-tab-bar .tab', { hasText: 'late.md' })).toHaveCount(1);
    await expect(page.locator('app-editor .cm-content')).toContainText('body late');
  });
});
