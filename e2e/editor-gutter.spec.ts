import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect, type Page } from './fixtures/drey';

/**
 * Regression guard for the line-number gutter alignment (milestone 19a):
 * CodeMirror sizes each gutter row to its line's measured height but does
 * not copy the content line-height, so without an explicit rule the number
 * glyph inherited the unitless `1.72` re-multiplied against its 10.5px font
 * and floated near the top of the row. `gutterTheme` now pins the gutter
 * element's line box to the body line-box height and top-aligns it.
 */

const NOTE = [
  '---',
  'title: Gutter',
  '---',
  '',
  '## A heading line rendered larger',
  '',
  'A first body line.',
  'A second body line.',
  'A third body line.',
  '',
].join('\n');

async function openWithLineNumbers(page: Page, vaultDir: string): Promise<void> {
  fs.writeFileSync(path.join(vaultDir, 'gutter.md'), NOTE);
  await page.locator('app-dock[side="left"] .icon-btn.refresh').click();
  await page.locator('app-dock[side="left"] .node.file', { hasText: 'gutter.md' }).click();
  await expect(page.locator('app-editor .cm-content')).toBeVisible();
  // Ctrl+G toggles the line-number gutter (KeybindingService 'editor.toggleLineNumbers').
  await page.locator('app-editor .cm-content').click();
  await page.keyboard.press('Control+g');
  await expect(page.locator('app-editor .cm-lineNumbers')).toBeVisible();
}

test.describe('line-number gutter alignment', () => {
  test('the gutter element line box matches the body line height', async ({ page, vaultDir }) => {
    await openWithLineNumbers(page, vaultDir);

    const metrics = await page.evaluate(() => {
      const scroller = document.querySelector('app-editor .cm-scroller') as HTMLElement;
      const lineHeightPx = parseFloat(getComputedStyle(scroller).lineHeight);
      const gutterEl = document.querySelector(
        'app-editor .cm-lineNumbers .cm-gutterElement:not(:first-child)',
      ) as HTMLElement;
      const cs = getComputedStyle(gutterEl);
      return {
        scrollerLineHeightPx: lineHeightPx,
        gutterLineHeightPx: parseFloat(cs.lineHeight),
        gutterDisplay: cs.display,
        gutterAlignItems: cs.alignItems,
      };
    });

    // The fix: an explicit px line-height equal to the content's body line
    // box (14.5 * 1.72), not the tiny inherited ~18px (10.5 * 1.72).
    expect(metrics.gutterLineHeightPx).toBeGreaterThan(22);
    expect(Math.abs(metrics.gutterLineHeightPx - metrics.scrollerLineHeightPx)).toBeLessThan(1.5);
    expect(metrics.gutterDisplay).toBe('flex');
    expect(metrics.gutterAlignItems).toBe('flex-start');
  });

  test('a body line: number is vertically centred in its row', async ({ page, vaultDir }) => {
    await openWithLineNumbers(page, vaultDir);

    // Line 7 in the doc is "A first body line." (1-based, frontmatter shown).
    const delta = await page.evaluate(() => {
      const lines = [
        ...document.querySelectorAll<HTMLElement>('app-editor .cm-content .cm-line'),
      ];
      const gutters = [
        ...document.querySelectorAll<HTMLElement>(
          'app-editor .cm-lineNumbers .cm-gutterElement',
        ),
      ].filter((el) => /^\d+$/.test((el.textContent ?? '').trim()));

      const bodyLine = lines.find((l) => l.textContent?.includes('first body line'))!;
      const gutter = gutters.find((g) => g.textContent?.trim() === '7')!;

      const lr = bodyLine.getBoundingClientRect();
      const gr = gutter.getBoundingClientRect();
      // Row tops must coincide (CodeMirror's own alignment) and the row
      // heights must match, so the centred digit lands on the text.
      return {
        topDelta: Math.abs(lr.top - gr.top),
        heightDelta: Math.abs(lr.height - gr.height),
      };
    });

    expect(delta.topDelta).toBeLessThan(2);
    expect(delta.heightDelta).toBeLessThan(2);
  });

  test('no markdown fold arrows in the gutter', async ({ page, vaultDir }) => {
    await openWithLineNumbers(page, vaultDir);

    const foldGutterVisible = await page.evaluate(() => {
      const fold = document.querySelector('app-editor .cm-foldGutter') as HTMLElement | null;
      if (!fold) {
        return false;
      }
      return getComputedStyle(fold).display !== 'none';
    });
    expect(foldGutterVisible).toBe(false);
  });
});
