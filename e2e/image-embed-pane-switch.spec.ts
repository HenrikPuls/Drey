import type { Locator } from '@playwright/test';
import { test, expect, type Page } from './fixtures/drey';
import { activeVaultAssetUrl } from './fixtures/asset-url';

/**
 * Bug repro: a split editor (two panes), one document embedding draw.io
 * SVG pictures, the other a plain note. Switching focus from the pictures'
 * pane to the other pane and back used to leave the embeds as "image not
 * found" placeholders (every candidate URL failed to load) until a further
 * click into the editor re-rendered them. The embeds must survive every
 * focus switch without breaking.
 *
 * The reported case embeds NOTE-RELATIVELY from a subfolder note -- an
 * embed resolved against the WRONG open document (image embeds resolve
 * through the focused pane's facade at decoration-build time) falls back
 * to the vault-root `attachments/` and finds nothing there. The vault-root
 * variant is the contrast case: note-relative and vault-root resolution
 * coincide there, so it only guards against fixes that merely special-case
 * the subfolder layout.
 */

const DIAGRAM_XML =
  '<mxfile><diagram name="Page-1"><mxGraphModel><root>' +
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="2" value="Box" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1">' +
  '<mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>' +
  '</root></mxGraphModel></diagram></mxfile>';

const escapeAttribute = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A draw.io picture as the plugin writes it: the diagram rides in the
 * `content` attribute, the SVG itself is an ordinary picture with real
 * dimensions -- so "loaded" is observable as `naturalWidth`.
 */
const diagramSvg = (label: string): string =>
  '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="160px" height="90px" ' +
  `viewBox="-0.5 -0.5 160 90" content="${escapeAttribute(DIAGRAM_XML)}">` +
  '<rect x="0.5" y="0.5" width="159" height="89" fill="#dae8fc" stroke="#6c8ebf"/>' +
  `<text x="12" y="50" font-family="Helvetica" font-size="14" fill="#333333">${label}</text>` +
  '</svg>\n';

const NOTE_BODY =
  '# Diagrams\n\n' +
  '![diagram one](attachments/diagram-1.drawio.svg)\n\n' +
  '![diagram two](attachments/diagram-2.drawio.svg)\n';

test.describe('embedded draw.io pictures survive split-pane focus switches', () => {
  test.describe('note in a subfolder (the reported case)', () => {
    test.use({
      seedVault: {
        'notes/attachments/diagram-1.drawio.svg': diagramSvg('One'),
        'notes/attachments/diagram-2.drawio.svg': diagramSvg('Two'),
        'notes/diagrams.md': NOTE_BODY,
        'other.md': '# Other\n\nplain text\n',
      },
    });

    test('switching to the other pane and back keeps both embeds loaded', async ({ page }) => {
      await embedsSurvivePaneSwitch(page, 'notes/diagrams.md');
    });
  });

  test.describe('note in the vault root (contrast case)', () => {
    test.use({
      seedVault: {
        'attachments/diagram-1.drawio.svg': diagramSvg('One'),
        'attachments/diagram-2.drawio.svg': diagramSvg('Two'),
        'diagrams.md': NOTE_BODY,
        'other.md': '# Other\n\nplain text\n',
      },
    });

    test('switching to the other pane and back keeps both embeds loaded', async ({ page }) => {
      await embedsSurvivePaneSwitch(page, 'diagrams.md');
    });
  });
});

/**
 * The editor showing `notePath`. `data-drey-doc` holds the pane's active
 * docKey (`<vaultId>::<path>`, the id is minted at first registration), so
 * the match is anchored on the `::` separator rather than the whole value.
 */
function editorFor(page: Page, notePath: string): Locator {
  return page.locator(`app-editor[data-drey-doc$="::${notePath}"]`);
}

/** The <img> really decoded its picture (not merely present in the DOM). */
async function expectLoaded(picture: Locator): Promise<void> {
  await expect
    .poll(() => picture.evaluate((node: HTMLImageElement) => node.naturalWidth))
    .toBeGreaterThan(10);
}

/** The note-relative embed reference for `name`, as seeded. */
function embedPath(notePath: string, name: string): string {
  const slash = notePath.lastIndexOf('/');
  return slash === -1 ? `attachments/${name}` : `${notePath.slice(0, slash)}/attachments/${name}`;
}

/**
 * The reported flow: open the diagram note, split the editor, open a plain
 * note in the freed pane, focus the plain note, focus back. After the
 * switch back neither embed may show the "image not found" placeholder,
 * and no `drey-asset://` request may have failed on the way.
 */
async function embedsSurvivePaneSwitch(page: Page, notePath: string): Promise<void> {
  const failed: string[] = [];
  page.on('requestfailed', (request) => {
    if (!request.url().startsWith('drey-asset://')) {
      return;
    }
    // An aborted load is a teardown artifact (the widget's DOM went away
    // mid-flight), not a serving failure -- a real miss answers 404.
    if (request.failure()?.errorText === 'net::ERR_ABORTED') {
      return;
    }
    failed.push(request.url());
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && response.url().startsWith('drey-asset://')) {
      failed.push(`${response.status()} ${response.url()}`);
    }
  });

  // Folders start collapsed each session; expand before the tree click.
  if (notePath.includes('/')) {
    await page.locator('app-dock[side="left"] .hdr-btn[aria-label="Expand all folders"]').click();
  }
  // Opening replaces the clean startup daily tab, so the pane holds a
  // single tab and the split moves it (milestone 32).
  await page.locator('app-dock[side="left"] .node.file', { hasText: 'diagrams.md' }).click();
  const note = editorFor(page, notePath);
  await expect(note).toHaveCount(1);

  // Both embeds render and load while their pane is focused.
  const pictures = note.locator('.cm-content .lp-image img');
  await expect(pictures).toHaveCount(2);
  await expect(pictures.nth(0)).toHaveAttribute(
    'src',
    await activeVaultAssetUrl(page, embedPath(notePath, 'diagram-1.drawio.svg')),
  );
  await expect(pictures.nth(1)).toHaveAttribute(
    'src',
    await activeVaultAssetUrl(page, embedPath(notePath, 'diagram-2.drawio.svg')),
  );
  await expectLoaded(pictures.nth(0));
  await expectLoaded(pictures.nth(1));

  // Split right: the single tab moves into the new pane, the source pane
  // empties. The click lands on the heading, away from the embeds.
  await note.locator('.cm-content').click({ position: { x: 30, y: 8 } });
  await page.keyboard.press('Control+Alt+Enter');
  await expect(page.locator('app-pane-leaf')).toHaveCount(2);

  // The plain note opens in the emptied pane (a click focuses a pane first).
  await page.locator('app-pane-leaf .empty').click();
  await page.locator('app-dock[side="left"] .node.file', { hasText: 'other.md' }).click();
  const other = editorFor(page, 'other.md');
  await expect(other).toHaveCount(1);

  // The reported switch: away from the pictures, then back.
  await other.locator('.cm-content').click();
  await note.locator('.cm-content').click({ position: { x: 30, y: 8 } });

  await expect(note.locator('.lp-image-missing')).toHaveCount(0);
  await expect(note.locator('.cm-content .lp-image img')).toHaveCount(2);
  await expectLoaded(pictures.nth(0));
  await expectLoaded(pictures.nth(1));
  expect(failed).toEqual([]);
}
