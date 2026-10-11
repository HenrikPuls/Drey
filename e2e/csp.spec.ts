import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from './fixtures/drey';

declare global {
  interface Window {
    __cspProbe?: string;
  }
}

/** One empty page; enough for the built-in viewer to accept the file. */
const MINIMAL_PDF = [
  '%PDF-1.4',
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj',
  'trailer<</Root 1 0 R>>',
  '%%EOF',
  '',
].join('\n');

test.describe('content security policy (ADR-0001, later change)', () => {
  test('a full page load reports no violation', async ({ page, cspViolations }) => {
    // The fixture attaches its listener after the first load began; a
    // reload replays the whole startup with the listener in place.
    await page.reload();
    await expect(page.locator('app-status-bar')).toContainText('words');
    await expect(page.locator('app-dock[side="left"]')).toBeVisible();
    expect(cspViolations).toEqual([]);
  });

  test('script that reaches the DOM does not run', async ({ page, cspViolations }) => {
    const evalBlocked = await page.evaluate(async () => {
      const inline = document.createElement('script');
      inline.textContent = 'window.__cspProbe = "inline script";';
      document.body.append(inline);

      const image = document.createElement('img');
      image.setAttribute('onerror', 'window.__cspProbe = "event handler";');
      image.src = 'app://app/does-not-exist.png';
      document.body.append(image);
      await new Promise<void>((resolve) => {
        image.addEventListener('error', () => resolve(), { once: true });
      });

      const remote = document.createElement('script');
      remote.src = 'https://example.invalid/x.js';
      document.body.append(remote);

      try {
        // The string goes through a variable so no bundler rewrites it.
        const source = 'window.__cspProbe = "eval"';
        window.setTimeout(source, 0);
        new Function(source)();
        return false;
      } catch {
        return true;
      }
    });
    await page.waitForTimeout(200);

    expect(evalBlocked).toBe(true);
    expect(await page.evaluate(() => window.__cspProbe)).toBeUndefined();
    expect(cspViolations.length).toBeGreaterThanOrEqual(3);
    cspViolations.length = 0;
  });

  test('a PDF tab still loads its frame', async ({ page, vaultDir, cspViolations }) => {
    fs.writeFileSync(path.join(vaultDir, 'paper.pdf'), MINIMAL_PDF, 'latin1');
    await page.locator('app-dock[side="left"] .hdr-btn[aria-label="Refresh files"]').click();
    await page.locator('app-dock[side="left"] .node.file', { hasText: 'paper.pdf' }).click();

    const frame = page.locator('app-pdf-tab iframe.frame');
    await expect(frame).toHaveAttribute('src', /^drey-asset:/);
    await expect
      .poll(() => page.frames().some((candidate) => candidate.url().startsWith('drey-asset:')))
      .toBe(true);
    await page.waitForTimeout(500);
    expect(cspViolations).toEqual([]);
  });

  test('a PDF embedded in a note is probed and framed', async ({ page, vaultDir, cspViolations }) => {
    fs.mkdirSync(path.join(vaultDir, 'attachments'), { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'attachments', 'paper.pdf'), MINIMAL_PDF, 'latin1');
    fs.writeFileSync(path.join(vaultDir, 'embed.md'), '# embed\n\n![paper](attachments/paper.pdf)\n\ntext\n');
    await page.locator('app-dock[side="left"] .hdr-btn[aria-label="Refresh files"]').click();
    await page.locator('app-dock[side="left"] .node.file', { hasText: 'embed.md' }).click();

    await expect(page.locator('app-editor .cm-content .lp-pdf iframe.lp-pdf-frame')).toHaveAttribute(
      'src',
      /^drey-asset:.*paper\.pdf/,
    );
    await expect(page.locator('app-editor .cm-content .lp-pdf-error')).toHaveCount(0);
    expect(cspViolations).toEqual([]);
  });

  test('raw HTML in a note runs nothing and raises no violation', async ({ page, vaultDir }) => {
    fs.writeFileSync(
      path.join(vaultDir, 'hostile.md'),
      [
        '# hostile',
        '',
        '<img src="x" onerror="window.__cspProbe = \'note image\'">',
        '',
        '<script>window.__cspProbe = "note script";</script>',
        '',
        '<a href="javascript:window.__cspProbe=\'note link\'">link</a>',
        '',
      ].join('\n'),
    );
    await page.locator('app-dock[side="left"] .hdr-btn[aria-label="Refresh files"]').click();
    await page.locator('app-dock[side="left"] .node.file', { hasText: 'hostile.md' }).click();
    await expect(page.locator('app-editor .cm-content')).toContainText('hostile');
    await page.waitForTimeout(500);

    expect(await page.evaluate(() => window.__cspProbe)).toBeUndefined();
  });
});
