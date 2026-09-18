import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect, type Page } from './fixtures/drey';
import { activeVaultAssetUrl } from './fixtures/asset-url';

/** A 1x1 transparent PNG. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==';

async function openNote(page: Page, vaultDir: string, name: string, body = '# pic\n\n'): Promise<void> {
  fs.writeFileSync(path.join(vaultDir, name), body);
  await page.locator('app-dock[side="left"] .hdr-btn[aria-label="Refresh files"]').click();
  await page.locator('app-dock[side="left"] .node.file', { hasText: name }).click();
  await expect(page.locator('app-editor .cm-content')).toBeVisible();
}

function attachmentsDir(vaultDir: string): string {
  return path.join(vaultDir, 'attachments');
}

/**
 * Dispatches a synthetic clipboard `paste` (or drag `drop`) carrying a PNG
 * `File` onto `selector`. Playwright can't put a real image on the OS
 * clipboard, so the extension's DOM handlers are driven directly.
 */
async function pasteImage(
  page: Page,
  selector: string,
  kind: 'paste' | 'drop' = 'paste',
): Promise<void> {
  await page.evaluate(
    ({ selector, kind, b64 }) => {
      const el = document.querySelector(selector);
      if (!el) {
        throw new Error(`no element for ${selector}`);
      }
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
      }
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
      // Chromium ignores `clipboardData` / `dataTransfer` passed to the
      // event constructor for script-made events, so shadow the getter on
      // the instance with our populated DataTransfer.
      const event =
        kind === 'paste'
          ? new ClipboardEvent('paste', { bubbles: true, cancelable: true })
          : new DragEvent('drop', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 });
      Object.defineProperty(event, kind === 'paste' ? 'clipboardData' : 'dataTransfer', {
        value: dt,
      });
      el.dispatchEvent(event);
    },
    { selector, kind, b64: PNG_BASE64 },
  );
}

test.describe('image capture — vault:save-asset IPC (ADR-0024)', () => {
  test('saves bytes into an attachments/ folder beside the note and returns a note-relative path', async ({
    page,
    vaultDir,
  }) => {
    const rel = await page.evaluate((b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
      }
      return window.dreyApi.saveVaultAsset(bytes, 'png', 'notes/topic/foo.md');
    }, PNG_BASE64);

    expect(rel).toMatch(/^attachments\/\d{4}-\d{2}-\d{2}-\d{6}-[0-9a-f]{6}\.png$/);

    const onDisk = path.join(vaultDir, 'notes', 'topic', rel);
    expect(fs.existsSync(onDisk)).toBe(true);
    expect(fs.readFileSync(onDisk).length).toBe(Buffer.from(PNG_BASE64, 'base64').length);
  });

  test('falls back to the vault-root attachments/ when there is no open note', async ({
    page,
    vaultDir,
  }) => {
    const rel = await page.evaluate((b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
      }
      return window.dreyApi.saveVaultAsset(bytes, 'png', '');
    }, PNG_BASE64);

    expect(rel).toMatch(/^attachments\/.+\.png$/);
    expect(fs.existsSync(path.join(vaultDir, rel))).toBe(true);
  });
});

/**
 * The insert places the caret on the line after the image, so Live
 * Preview renders it straight away (no caret nudge needed). The failure /
 * no-vault path is a unit test (src/app/editor/image-paste.spec.ts) --
 * `window.dreyApi` is a frozen contextBridge object and can't be stubbed
 * from the page.
 */
test.describe('image capture — paste & drop in the editors', () => {
  async function expectOneSavedImage(vaultDir: string): Promise<void> {
    await expect
      .poll(() =>
        fs.existsSync(attachmentsDir(vaultDir)) ? fs.readdirSync(attachmentsDir(vaultDir)).length : 0,
      )
      .toBe(1);
  }

  test('pasting into the main editor saves the file and renders it inline', async ({
    page,
    vaultDir,
  }) => {
    await openNote(page, vaultDir, 'pic.md');
    await page.locator('app-editor .cm-content').click();

    await pasteImage(page, 'app-editor .cm-content');

    await expectOneSavedImage(vaultDir);
    const savedName = fs.readdirSync(attachmentsDir(vaultDir))[0];
    expect(savedName).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}-[0-9a-f]{6}\.png$/);
    // Since ADR-0051 the asset URL carries the minted vault id as its host.
    await expect(page.locator('app-editor .cm-content .lp-image img')).toHaveAttribute(
      'src',
      await activeVaultAssetUrl(page, `attachments/${savedName}`),
    );
  });

  test('dropping an image into the main editor works the same way', async ({ page, vaultDir }) => {
    await openNote(page, vaultDir, 'drop.md');
    await page.locator('app-editor .cm-content').click();

    await pasteImage(page, 'app-editor .cm-content', 'drop');

    await expectOneSavedImage(vaultDir);
    const savedName = fs.readdirSync(attachmentsDir(vaultDir))[0];
    await expect(page.locator('app-editor .cm-content .lp-image img')).toHaveAttribute(
      'src',
      await activeVaultAssetUrl(page, `attachments/${savedName}`),
    );
  });

  test('pasting into the "Add entry" drawer saves an image too', async ({ page, vaultDir }) => {
    await openNote(page, vaultDir, 'entry.md');

    const bottom = page.locator('app-dock[side="bottom"]');
    await bottom.locator('app-panel-frame .head').first().click();
    const surface = bottom.locator('app-entry-drawer .md-editor .cm-content');
    await surface.click();

    await pasteImage(page, 'app-entry-drawer .md-editor .cm-content');

    await expectOneSavedImage(vaultDir);
    const savedName = fs.readdirSync(attachmentsDir(vaultDir))[0];
    await expect(surface.locator('.lp-image img')).toHaveAttribute(
      'src',
      await activeVaultAssetUrl(page, `attachments/${savedName}`),
    );
  });

  test('a non-image paste falls through to the default text paste', async ({ page, vaultDir }) => {
    await openNote(page, vaultDir, 'text.md');
    await page.locator('app-editor .cm-content').click();

    await page.evaluate(() => {
      const el = document.querySelector('app-editor .cm-content')!;
      const dt = new DataTransfer();
      dt.setData('text/plain', 'just words');
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: dt });
      el.dispatchEvent(event);
    });

    await expect(page.locator('app-editor .cm-content')).toContainText('just words');
    expect(fs.existsSync(attachmentsDir(vaultDir))).toBe(false);
  });
});

test.describe('inline image sizing — ![alt|W]', () => {
  test('an image with a |width suffix renders at that width', async ({ page, vaultDir }) => {
    fs.mkdirSync(path.join(vaultDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'assets', 'p.png'), Buffer.from(PNG_BASE64, 'base64'));
    fs.writeFileSync(path.join(vaultDir, 'sized.md'), '# sized\n\n![shot|140](assets/p.png)\n');

    await page.locator('app-dock[side="left"] .hdr-btn[aria-label="Refresh files"]').click();
    await page.locator('app-dock[side="left"] .node.file', { hasText: 'sized.md' }).click();

    const img = page.locator('app-editor .cm-content .lp-image img');
    await expect(img).toHaveAttribute('src', await activeVaultAssetUrl(page, 'assets/p.png'));
    await expect(img).toHaveAttribute('style', /width:\s*140px/);
  });
});
