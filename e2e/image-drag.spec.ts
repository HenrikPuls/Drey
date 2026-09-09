import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect, type Page } from './fixtures/drey';

/** A 1x1 PNG. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==';

async function openNote(page: Page, vaultDir: string, name: string, body: string): Promise<void> {
  fs.mkdirSync(path.dirname(path.join(vaultDir, name)), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, name), body);
  await page.locator('app-dock[side="left"] .icon-btn.refresh').click();
  await page.locator('app-dock[side="left"] .node.file', { hasText: path.basename(name) }).click();
  await expect(page.locator('app-editor .cm-content')).toBeVisible();
}

/** Dispatch dragover + drop on `.cm-content` with a DataTransfer carrying `data`. */
async function dropOnEditor(page: Page, data: Record<string, string>): Promise<void> {
  await page.evaluate((entries) => {
    const el = document.querySelector('app-editor .cm-content')!;
    const dt = new DataTransfer();
    for (const [type, value] of Object.entries(entries)) {
      dt.setData(type, value);
    }
    for (const name of ['dragover', 'drop'] as const) {
      const event = new DragEvent(name, { bubbles: true, cancelable: true, clientX: 60, clientY: 60 });
      Object.defineProperty(event, 'dataTransfer', { value: dt });
      el.dispatchEvent(event);
    }
  }, data);
}

test.describe('drag a vault file into the editor', () => {
  test('a vault image is linked in place, relative to the note, with no copy', async ({
    page,
    vaultDir,
  }) => {
    fs.mkdirSync(path.join(vaultDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'assets', 'logo.png'), Buffer.from(PNG_BASE64, 'base64'));
    await openNote(page, vaultDir, 'notes/topic/n.md', '# n\n\n');
    await page.locator('app-editor .cm-content').click();

    await dropOnEditor(page, { 'application/x-drey-vault-path': 'assets/logo.png' });

    // Rendered inline from the relative path, no attachments/ copy.
    const img = page.locator('app-editor .cm-content .lp-image img');
    await expect(img).toHaveAttribute('src', /^drey-asset:\/\/asset\/assets\/logo\.png$/);
    expect(fs.existsSync(path.join(vaultDir, 'attachments'))).toBe(false);

    // Persisted markdown carries the ../../ relative path.
    await page.keyboard.press('ControlOrMeta+s');
    await expect
      .poll(() => fs.readFileSync(path.join(vaultDir, 'notes', 'topic', 'n.md'), 'utf-8'))
      .toContain('![](../../assets/logo.png)');
  });

  test('a vault text file is inlined at the drop point', async ({ page, vaultDir }) => {
    fs.writeFileSync(path.join(vaultDir, 'snippet.md'), 'reusable **snippet** text\n');
    await openNote(page, vaultDir, 'main.md', '# main\n\n');
    await page.locator('app-editor .cm-content').click();

    await dropOnEditor(page, { 'application/x-drey-vault-path': 'snippet.md' });

    await expect(page.locator('app-editor .cm-content')).toContainText('reusable');
    await page.keyboard.press('ControlOrMeta+s');
    await expect
      .poll(() => fs.readFileSync(path.join(vaultDir, 'main.md'), 'utf-8'))
      .toContain('reusable **snippet** text');
  });

  test('a web image dragged from a browser is downloaded and given a [Source] line', async ({
    page,
    vaultDir,
  }) => {
    const png = Buffer.from(PNG_BASE64, 'base64');
    const server = http.createServer((req, res) => {
      if (req.url === '/pic.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(png);
      } else {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<h1>not an image</h1>');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;

    try {
      await openNote(page, vaultDir, 'web.md', '# web\n\n');
      await page.locator('app-editor .cm-content').click();

      await dropOnEditor(page, { 'text/uri-list': `http://127.0.0.1:${port}/pic.png` });

      await expect
        .poll(() =>
          fs.existsSync(path.join(vaultDir, 'attachments'))
            ? fs.readdirSync(path.join(vaultDir, 'attachments')).length
            : 0,
        )
        .toBe(1);
      await page.keyboard.press('ControlOrMeta+s');
      await expect
        .poll(() => fs.readFileSync(path.join(vaultDir, 'web.md'), 'utf-8'))
        .toMatch(/!\[\]\(attachments\/.+\.png\)\n\[Source\]\(<http:\/\/127\.0\.0\.1:\d+\/pic\.png>\)/);

      // A non-image URL is rejected with a notice, nothing written.
      await dropOnEditor(page, { 'text/uri-list': `http://127.0.0.1:${port}/page.png` });
      await expect(page.locator('app-editor .err')).toContainText(/image/i);
      expect(fs.readdirSync(path.join(vaultDir, 'attachments'))).toHaveLength(1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test('an OS text file dropped from the file manager is inlined', async ({ page, vaultDir }) => {
    await openNote(page, vaultDir, 'target.md', '# target\n\n');
    await page.locator('app-editor .cm-content').click();

    await page.evaluate(() => {
      const el = document.querySelector('app-editor .cm-content')!;
      const dt = new DataTransfer();
      dt.items.add(new File(['- one\n- two\n'], 'checklist.md', { type: 'text/plain' }));
      for (const name of ['dragover', 'drop'] as const) {
        const event = new DragEvent(name, { bubbles: true, cancelable: true, clientX: 60, clientY: 60 });
        Object.defineProperty(event, 'dataTransfer', { value: dt });
        el.dispatchEvent(event);
      }
    });

    await expect(page.locator('app-editor .cm-content')).toContainText('two');
    await page.keyboard.press('ControlOrMeta+s');
    await expect
      .poll(() => fs.readFileSync(path.join(vaultDir, 'target.md'), 'utf-8'))
      .toContain('- one\n- two');
  });
});
