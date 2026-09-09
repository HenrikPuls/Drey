import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect, type Page } from './fixtures/drey';

async function openNote(page: Page, vaultDir: string, name: string, body: string): Promise<void> {
  fs.writeFileSync(path.join(vaultDir, name), body);
  await page.locator('app-dock[side="left"] .icon-btn.refresh').click();
  await page.locator('app-dock[side="left"] .node.file', { hasText: name }).click();
  await expect(page.locator('app-editor .cm-content')).toBeVisible();
}

const DIAGRAM = '# diagram\n\n```mermaid\ngraph TD;\n  A-->B;\n  B-->C;\n```\n';

test.describe('mermaid diagrams in Live Preview (ADR-0025)', () => {
  test('a ```mermaid fence renders as an <svg> in the main editor', async ({ page, vaultDir }) => {
    await openNote(page, vaultDir, 'flow.md', DIAGRAM);

    const svg = page.locator('app-editor .cm-content .lp-mermaid svg');
    await expect(svg).toBeVisible({ timeout: 15000 });
    // A real diagram, not the pending placeholder or an error box.
    await expect(page.locator('app-editor .cm-content .lp-mermaid-pending')).toHaveCount(0);
    await expect(page.locator('app-editor .cm-content .lp-mermaid-error')).toHaveCount(0);

    // Req-1: the </> "view source" button and the zoom lens sit side by
    // side in the corner cluster, no longer stacked on top of each other.
    const diagram = page.locator('app-editor .cm-content .lp-mermaid');
    await diagram.hover();
    const edit = await diagram.locator('.lp-edit').boundingBox();
    const lens = await diagram.locator('.lp-mermaid-lens').boundingBox();
    expect(edit && lens).toBeTruthy();
    const disjoint =
      edit!.x + edit!.width <= lens!.x + 0.5 || lens!.x + lens!.width <= edit!.x + 0.5;
    expect(disjoint).toBe(true);
  });

  test('the raw fence comes back when the cursor moves inside it', async ({ page, vaultDir }) => {
    await openNote(page, vaultDir, 'reveal.md', DIAGRAM);
    await expect(page.locator('app-editor .cm-content .lp-mermaid svg')).toBeVisible({
      timeout: 15000,
    });

    // The hover </> drops the caret into the block's source.
    await page.locator('app-editor .cm-content .lp-mermaid .lp-edit').click();

    await expect(page.locator('app-editor .cm-content .lp-mermaid')).toHaveCount(0);
    await expect(page.locator('app-editor .cm-content')).toContainText('graph TD;');
  });

  test('the hover lens opens the diagram in the image lightbox', async ({ page, vaultDir }) => {
    await openNote(page, vaultDir, 'zoom.md', DIAGRAM);
    const diagram = page.locator('app-editor .cm-content .lp-mermaid');
    await expect(diagram.locator('svg')).toBeVisible({ timeout: 15000 });

    await diagram.hover();
    await diagram.locator('.lp-mermaid-lens').click({ force: true });

    const lightbox = page.locator('app-image-lightbox .backdrop');
    await expect(lightbox).toBeVisible();
    await expect(lightbox.locator('app-image-viewer img')).toHaveAttribute(
      'src',
      /^data:image\/svg\+xml/,
    );
  });

  test('a broken diagram shows an inline error box, not a crash', async ({ page, vaultDir }) => {
    await openNote(
      page,
      vaultDir,
      'broken.md',
      '# broken\n\n```mermaid\ngraph TD;\n  A -->\n```\n',
    );

    await expect(page.locator('app-editor .cm-content .lp-mermaid-error')).toBeVisible({
      timeout: 15000,
    });
    // No successfully-rendered diagram alongside the error.
    await expect(page.locator('app-editor .cm-content .lp-mermaid .lp-mermaid-svg')).toHaveCount(0);
    // Clicking the error box itself drops the caret into the fence to fix it.
    await page.locator('app-editor .cm-content .lp-mermaid-error').click();
    await expect(page.locator('app-editor .cm-content .lp-mermaid')).toHaveCount(0);
    await expect(page.locator('app-editor .cm-content')).toContainText('A -->');
    // The app is still alive and responsive.
    await expect(page.locator('app-titlebar .brand .mark')).toBeVisible();
  });

  test('the "Add entry" drawer renders a diagram too (shared surface)', async ({
    page,
    vaultDir,
  }) => {
    await openNote(page, vaultDir, 'note.md', '# note\n');

    const bottom = page.locator('app-dock[side="bottom"]');
    await bottom.locator('app-panel-frame .head').first().click();
    const surface = bottom.locator('app-entry-drawer .md-editor .cm-content');
    await surface.click();
    await page.keyboard.insertText('intro\n\n```mermaid\ngraph LR; X-->Y;\n```');
    // Move the caret off the fence so it renders (it must not touch it).
    await surface.press('ControlOrMeta+Home');

    await expect(surface.locator('.lp-mermaid svg')).toBeVisible({ timeout: 15000 });
  });

  // Regression: mermaid's config `fontFamily` is `var(--font-sans, …)`, which
  // it resolves to a fallback sans in its offscreen measuring node while the
  // diagram paints with the editor's typeface. With a non-sans editor font
  // (Settings → Appearance) that made every node box too narrow and the label
  // spilled past its rectangle. `MermaidWidget` now re-pins the resolved font
  // before each render, so measurement and paint agree.
  test.describe('non-sans editor typeface', () => {
    test.use({ appConfig: { editor: { fontFamily: 'mono' } } });

    test('node label boxes fit the rendered monospace text', async ({ page, vaultDir }) => {
      await openNote(page, vaultDir, 'mono.md', DIAGRAM);
      await expect(page.locator('app-editor .cm-content .lp-mermaid svg')).toBeVisible({
        timeout: 15000,
      });
      await page.waitForTimeout(300);

      const overflow = await page.evaluate(() => {
        const svg = document.querySelector('.lp-mermaid .lp-mermaid-svg svg');
        if (!svg) return ['NO SVG'];
        const bad: string[] = [];
        svg.querySelectorAll('foreignObject').forEach((fo) => {
          const div = fo.querySelector('div');
          if (!div || !div.textContent?.trim()) return;
          const boxW = (fo as SVGForeignObjectElement).width.baseVal.value;
          if (div.scrollWidth > Math.ceil(boxW) + 1) {
            bad.push(`"${div.textContent.trim()}" text ${div.scrollWidth}px > box ${boxW}px`);
          }
        });
        return bad;
      });
      expect(overflow).toEqual([]);
    });
  });
});
