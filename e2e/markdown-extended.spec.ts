import { test, expect } from './fixtures/drey';

/**
 * The extended-Markdown dialect (milestone 72) in the editor's Live
 * Preview: `==highlight==`, Pandoc sub/superscript, curated `:emoji:`
 * shortcodes, GitHub/Obsidian callouts, `$…$` / `$$…$$` math (KaTeX,
 * lazy-loaded), footnotes, and bare-URL autolinking — the constructs
 * `src/app/editor/markdown-extensions.ts` parses and the conceal /
 * block-render layers draw. PDF parity is pinned in the pdf-html unit
 * suite; this file pins the editor surfaces every Markdown view shares.
 *
 * The second describe pins the insert affordances added with them: the
 * slash commands, the context menu's formatting strip, the toolbar, the
 * `:emoji:` picker and the `:`-completion.
 */

const NOTE = [
  '# Syntax demo',
  '',
  'A ==highlighted phrase== in prose.',
  '',
  'Water H~2~O and X^2^ plus a :joy: emoji.',
  '',
  '> [!NOTE] Custom headline',
  '> Body of the note callout.',
  '',
  '> [!WARNING]',
  '> Careful here.',
  '',
  'Inline $a^2 + b^2 = c^2$ formula.',
  '',
  '$$',
  '\\int_0^1 x\\,dx = \\frac{1}{2}',
  '$$',
  '',
  'A claim[^1] in text.',
  '',
  '[^1]: The footnote definition.',
  '',
  '| a | b |',
  '| - | - |',
  '| ==cell== | H~2~O |',
  '',
  'Visit https://example.com/auto and `https://example.com/linked`.',
  '',
].join('\n');

test.use({ seedVault: { 'syntax-demo.md': NOTE } });

test.describe('Extended Markdown in Live Preview (milestone 71)', () => {
  test.beforeEach(async ({ page }) => {
    await page.locator('app-dock[side="left"] .node.file', { hasText: 'syntax-demo.md' }).click();
    await expect(page.locator('app-editor .cm-content')).toBeVisible();
  });

  test('highlights, subscript, superscript and emoji render concealed', async ({ page }) => {
    const content = page.locator('app-editor .cm-content');
    await expect(content.locator('.lp-mark')).toHaveText('highlighted phrase');
    await expect(content.locator('.lp-sub')).toHaveText('2');
    await expect(content.locator('.lp-sup')).toHaveText('2');
    await expect(content.locator('.lp-emoji')).toHaveText('😂');
  });

  test('callouts render as tinted boxes with icon and title', async ({ page }) => {
    const content = page.locator('app-editor .cm-content');
    const note = content.locator('.lp-callout.lp-callout-note');
    await expect(note).toHaveCount(2); // two quote lines share the container classes
    await expect(note.locator('.lp-callout-title')).toHaveText('📝');
    await expect(content.locator('.lp-callout-warning .lp-callout-title')).toHaveText('⚠️Warning');
    // The custom headline stays text right of the marker widget.
    await expect(content).toContainText('Custom headline');
  });

  test('math typesets through KaTeX, inline and display', async ({ page }) => {
    const content = page.locator('app-editor .cm-content');
    // The KaTeX runtime loads lazily — first formula pays the chunk.
    await expect(content.locator('.lp-math-inline .katex')).toBeVisible({ timeout: 20000 });
    await expect(content.locator('.lp-math-block .katex-display')).toBeVisible({
      timeout: 20000,
    });
  });

  test('footnote refs show their number and definitions their mark', async ({ page }) => {
    const content = page.locator('app-editor .cm-content');
    await expect(content.locator('.lp-footnote-ref').first()).toHaveText('1');
    await expect(content.locator('.lp-footnote-def')).toHaveCount(1);
  });

  test('extended inline syntax renders inside table cells', async ({ page }) => {
    const table = page.locator('app-editor .cm-content .lp-table table');
    await expect(table.locator('mark')).toHaveText('cell');
    await expect(table.locator('sub')).toHaveText('2');
  });

  test('moving the caret into a highlight reveals its raw markers', async ({ page }) => {
    const mark = page.locator('app-editor .cm-content .lp-mark');
    await mark.click();
    // Selection touches the construct: the `==` marks are back. The wash
    // itself stays — a readability cue, like a done task's strike-through.
    await expect(page.locator('app-editor .cm-content')).toContainText('==highlighted phrase==');
    await expect(mark).toHaveCount(1);
  });
});

test.describe('Extended Markdown insert affordances (milestone 72)', () => {
  test.beforeEach(async ({ page }) => {
    await page.locator('app-dock[side="left"] .node.file', { hasText: 'syntax-demo.md' }).click();
    await expect(page.locator('app-editor .cm-content')).toBeVisible();
  });

  test('the slash menu applies a callout through the shared reducer', async ({ page }) => {
    const content = page.locator('app-editor .cm-content');
    await expect(content.locator('.lp-callout-title')).toHaveCount(2);
    // The trailing empty line: `/cal` opens the dialog at a line start.
    await content.locator('.cm-line').last().click();
    await page.keyboard.type('/cal');
    await expect(page.locator('.cm-tooltip-autocomplete')).toBeVisible();
    // CodeMirror ignores an accept in the first moments after the popup
    // changed (its interaction delay, a guard against accidental Enter).
    await page.waitForTimeout(250);
    await page.keyboard.press('Enter');
    // A third callout title -- the marker line became a NOTE box. Without
    // a custom title the keyword's label renders next to the icon.
    await expect(content.locator('.lp-callout-title')).toHaveCount(3);
    await expect(content.locator('.lp-callout.lp-callout-note .lp-callout-title').last()).toHaveText(
      '📝Note',
    );
  });

  test('the context menu carries the formatting strip and inserts a footnote', async ({ page }) => {
    const content = page.locator('app-editor .cm-content');
    // Select the claim line (triple click), then right-click on it.
    const claim = content.locator('.cm-line', { hasText: 'A claim' });
    await claim.click({ clickCount: 3 });
    await claim.click({ button: 'right' });
    const menu = page.locator('.ctx-menu');
    await expect(menu).toBeVisible();
    // The formatting commands are the strip's icons now, not menu rows.
    await expect(menu).not.toContainText('Highlight');
    const strip = page.locator('.ctx-strip app-markdown-toolbar');
    await expect(strip).toBeVisible();
    await strip.locator('button[aria-label="Insert"]').click();
    // One menu at a time: the clipboard list is the strip's first menu
    // and closes while another one is open.
    await expect(strip.locator('.bar > button').first()).toHaveAttribute(
      'aria-label',
      'Clipboard and more',
    );
    await expect(menu).toBeHidden();
    await strip.locator('.menu button', { hasText: 'Footnote' }).click();
    await expect(menu).toHaveCount(0);
    // A second numbered ref on the claim line plus its definition block.
    // (Definition lines carry their own numbered marks -- scope to the
    // claim line, and give conceal a beat to re-decorate.)
    const claimRefs = content.locator('.cm-line', { hasText: 'in text.' }).locator('sup.lp-footnote-ref');
    await expect(claimRefs).toHaveCount(2);
    await expect(claimRefs.nth(1)).toHaveText('2');
    await expect(content.locator('.lp-footnote-def')).toHaveCount(2);
  });

  test('the pin releases the strip from the meta bar and docks it back', async ({ page }) => {
    const docked = page.locator('app-editor .chrome app-markdown-toolbar');
    await expect(docked).toBeVisible();
    await docked.locator('button.pin').click();
    await expect(docked).toHaveCount(0);
    // Released, the strip is still at hand in the right-click menu.
    await page.locator('app-editor .cm-content .cm-line', { hasText: 'A claim' }).click({ button: 'right' });
    const pin = page.locator('.ctx-strip app-markdown-toolbar button.pin');
    await expect(pin).toHaveAttribute('aria-pressed', 'false');
    await pin.click();
    await expect(docked).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.ctx-menu')).toHaveCount(0);
  });

  test('the toolbar Insert menu opens the emoji picker and inserts :fire:', async ({ page }) => {
    const content = page.locator('app-editor .cm-content');
    // Live Preview conceals the syntax: the line READS "Water H2O and X2…".
    await content.locator('.cm-line', { hasText: 'Water H2O' }).click();
    await page.keyboard.press('End');
    await page.locator('app-editor app-markdown-toolbar button[aria-label="Insert"]').click();
    await page.locator('app-editor app-markdown-toolbar .menu button', { hasText: 'Emoji' }).click();
    const panel = page.locator('.emoji-panel');
    await expect(panel).toBeVisible();
    await panel.locator('.emoji-search').fill('fire');
    await panel.locator('.emoji-cell[aria-label=":fire:"]').click();
    await expect(panel).toHaveCount(0);
    // Conceal keeps widgets away from the caret -- park it at the line
    // start so both shortcodes render their glyphs.
    await page.keyboard.press('Home');
    await expect(content.locator('.lp-emoji')).toHaveCount(2);
    await expect(content.locator('.lp-emoji').last()).toHaveText('🔥');
  });

  test('typing :tro completes the shortcode from the curated table', async ({ page }) => {
    const content = page.locator('app-editor .cm-content');
    // Concealed line: "…plus a 😂 emoji." -- match the rendered text.
    await content.locator('.cm-line', { hasText: 'plus a' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' :tro');
    const popup = page.locator('.cm-tooltip-autocomplete');
    await expect(popup).toBeVisible();
    await popup.locator('li', { hasText: ':trophy:' }).click();
    // Park the caret away from the shortcode so conceal shows the glyph.
    await page.keyboard.press('Home');
    await expect(content.locator('.lp-emoji')).toHaveCount(2);
    await expect(content.locator('.lp-emoji').last()).toHaveText('🏆');
  });

  test('the eraser peels formatting layer by layer (Mod+\\ and toolbar)', async ({ page }) => {
    const content = page.locator('app-editor .cm-content');
    await content.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('**fett ==rot== hier**');
    // Park the caret inside "rot" (line start + 10 -> between r and o).
    await page.keyboard.press('Home');
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('ArrowRight');
    }
    // Stroke 1 (the shortcut): the OUTERMOST wrap goes -- the bold, the
    // highlight stays and renders (park the caret so conceal hides the
    // markers again before asserting).
    await page.keyboard.press('Control+\\');
    const line = content.locator('.cm-line', { hasText: 'fett' });
    await page.keyboard.press('Home');
    await expect(line.locator('.lp-mark')).toHaveText('rot');
    // Stroke 2 (the toolbar's text-format menu): the highlight goes too. The line is
    // "fett ==rot== hier" now -- 9 steps land inside "rot".
    for (let i = 0; i < 9; i++) {
      await page.keyboard.press('ArrowRight');
    }
    await page.locator('app-editor app-markdown-toolbar button[aria-label="More text formats"]').click();
    await page
      .locator('app-editor app-markdown-toolbar .menu button', { hasText: 'Clear formatting' })
      .click();
    await expect(line.locator('.lp-mark')).toHaveCount(0);
    await expect(line).toHaveText(/fett\s+rot\s+hier/);
  });
});
