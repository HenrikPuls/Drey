import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect, type Page } from './fixtures/drey';
import { placeholderDiagramPng, pngDiagramXml } from '../plugins/drawio/renderer/diagram-file';

/**
 * The diagrams plugin (ADR-0064): a diagram file opens in the bundled
 * draw.io editor, and a change is written back on its own.
 *
 * The editor is a separate download (`npm run fetch:drawio`); without it
 * the built plugin has no `webapp/` folder and these tests skip.
 */
const webapp = path.resolve(
  __dirname,
  '..',
  'dist-electron',
  'plugins',
  'drawio',
  'webapp',
  'index.html',
);

const DIAGRAM_XML =
  '<mxfile><diagram name="Page-1"><mxGraphModel><root>' +
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="2" value="Box" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1">' +
  '<mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>' +
  '</root></mxGraphModel></diagram></mxfile>';

const escapeAttribute = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const DIAGRAM_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="1px" height="1px" ' +
  `viewBox="-0.5 -0.5 1 1" content="${escapeAttribute(DIAGRAM_XML)}"></svg>\n`;

async function openFromTree(page: Page, name: string): Promise<void> {
  await page.locator('app-dock[side="left"] .node.file', { hasText: name }).click();
}

/**
 * Runs a command through the command palette. The palette is an Angular
 * overlay: keys typed before it mounts are dropped or split the query, and
 * the remnant can rank another command first (bug-12) -- so wait for the
 * dialog and for the filtered row before Enter.
 */
async function runCommand(page: Page, label: string): Promise<void> {
  await page.keyboard.press('Control+Shift+P');
  await expect(page.locator('app-palette .palette')).toBeVisible();
  await page.keyboard.type(label);
  await expect(page.locator('app-palette .palette .item', { hasText: label })).toBeVisible();
  await page.keyboard.press('Enter');
}

/** Selects everything in the editor frame and nudges it one step right. */
async function moveTheBox(page: Page): Promise<void> {
  const frame = page.frameLocator('iframe.drawio-frame');
  const canvas = frame.locator('.geDiagramContainer');
  await expect(canvas).toBeVisible({ timeout: 30000 });
  await expect(frame.locator('.geDiagramContainer svg', { hasText: 'Box' })).toBeVisible({
    timeout: 30000,
  });
  // An empty spot of the canvas, away from the box and the side panels.
  await canvas.click({ position: { x: 400, y: 400 } });
  await page.keyboard.press('Control+A');
  await page.keyboard.press('ArrowRight');
}

test.describe('draw.io diagrams (ADR-0064)', () => {
  test.skip(!fs.existsSync(webapp), 'draw.io web app not fetched (npm run fetch:drawio)');

  test.use({
    seedVault: {
      'plain.drawio': DIAGRAM_XML,
      'picture.drawio.svg': DIAGRAM_SVG,
      'note.md': '# Note\n\n![diagram](picture.drawio.svg)\n\nend\n',
      'empty.md': '# Empty\n\n',
    },
  });

  test('a .drawio file opens in the editor and a change is saved', async ({ page, vaultDir }) => {
    const failed: string[] = [];
    page.on('requestfailed', (request) => failed.push(request.url()));
    page.on('response', (response) => {
      if (response.status() >= 400 && response.url().startsWith('plugin://drawio/')) {
        failed.push(`${response.status()} ${response.url()}`);
      }
    });

    await openFromTree(page, 'plain.drawio');
    await expect(page.locator('app-tab-bar', { hasText: 'plain.drawio' })).toBeVisible();
    await moveTheBox(page);

    const file = path.join(vaultDir, 'plain.drawio');
    await expect
      .poll(() => fs.readFileSync(file, 'utf8'), { timeout: 15000 })
      .not.toBe(DIAGRAM_XML);
    expect(fs.readFileSync(file, 'utf8')).toContain('<mxfile');
    // Nothing the offline editor asked for is missing from the trimmed copy
    // (the service worker is left out on purpose).
    expect(failed.filter((url) => !url.includes('service-worker'))).toEqual([]);
  });

  test('a .drawio.svg is written back as a picture that still holds the diagram', async ({
    page,
    vaultDir,
  }) => {
    await openFromTree(page, 'picture.drawio.svg');
    await moveTheBox(page);

    const file = path.join(vaultDir, 'picture.drawio.svg');
    await expect
      .poll(() => fs.readFileSync(file, 'utf8'), { timeout: 15000 })
      .not.toBe(DIAGRAM_SVG);
    const saved = fs.readFileSync(file, 'utf8');
    expect(saved).toContain('<svg');
    expect(saved).toContain('content="');
    expect(saved).toContain('Box');
    expect(saved).not.toContain('width="1px"');
  });

  test('a .drawio.png is written back as a PNG that still holds the diagram', async ({
    page,
    vaultDir,
  }) => {
    const file = path.join(vaultDir, 'bitmap.drawio.png');
    const seeded = placeholderDiagramPng(DIAGRAM_XML);
    fs.writeFileSync(file, seeded);
    // The hand-built placeholder is a PNG a browser really decodes.
    const decoded = await page.evaluate(async (bytes) => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
      return [bitmap.width, bitmap.height];
    }, Array.from(seeded));
    expect(decoded).toEqual([1, 1]);
    await page.locator('app-dock[side="left"] .hdr-btn[aria-label="Refresh files"]').click();
    await openFromTree(page, 'bitmap.drawio.png');
    await moveTheBox(page);

    await expect.poll(() => fs.statSync(file).size, { timeout: 15000 }).not.toBe(seeded.length);
    const saved = new Uint8Array(fs.readFileSync(file));
    // Still a PNG, now a real rendering, and the model is inside.
    expect(Array.from(saved.subarray(1, 4))).toEqual([0x50, 0x4e, 0x47]);
    expect(saved.length).toBeGreaterThan(seeded.length);
    expect(pngDiagramXml(saved)).toContain('Box');
  });

  test('"Edit diagram" on an embedded picture opens it, and the picture follows the save', async ({
    page,
    vaultDir,
  }) => {
    await openFromTree(page, 'note.md');
    const picture = page.locator('app-editor .cm-content .lp-image img');
    await expect(picture).toBeVisible();
    // The seeded 1px picture: the click lands in the box around it, not on it.
    await page.locator('app-editor .cm-content .lp-image').first().click({ button: 'right' });
    await page.locator('.ctx-menu button', { hasText: 'Edit diagram' }).click();

    await moveTheBox(page);
    await expect
      .poll(() => fs.readFileSync(path.join(vaultDir, 'picture.drawio.svg'), 'utf8'), {
        timeout: 15000,
      })
      .not.toBe(DIAGRAM_SVG);
    // Back in the note, the picture is the saved rendering, not the cached 1px seed.
    await page.locator('app-tab-bar .tab', { hasText: 'note.md' }).click();
    await expect(picture).toHaveAttribute('src', /\?v=\d+$/, { timeout: 15000 });
    await expect
      .poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth), { timeout: 15000 })
      .toBeGreaterThan(10);
  });

  test('the format of new diagrams is a setting (SVG by default, PNG on request)', async ({
    page,
    vaultDir,
  }) => {
    await page.locator('app-status-bar .settings').click();
    await page.locator('app-settings .category', { hasText: 'Diagrams' }).click();
    const format = page.locator('app-settings #drawio-new-format');
    await expect(format).toHaveValue('svg');
    await format.selectOption('png');
    // A plugin page saves at once; nothing is pending, so Escape just closes.
    await page.keyboard.press('Escape');
    await expect(page.locator('app-settings')).toHaveCount(0);

    await runCommand(page, 'New diagram');
    await expect(page.locator('iframe.drawio-frame')).toBeVisible({ timeout: 30000 });
    const created = (fs.readdirSync(vaultDir, { recursive: true }) as string[]).filter((name) =>
      path.basename(name).startsWith('diagram-'),
    );
    expect(created).toHaveLength(1);
    expect(created[0].endsWith('.drawio.png')).toBe(true);
    // A real placeholder picture (IHDR width / height), carrying the empty diagram.
    const png = fs.readFileSync(path.join(vaultDir, created[0]));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([240, 120]);
    expect(pngDiagramXml(new Uint8Array(png))).toContain('<mxfile>');
  });

  test('a new diagram is a visible placeholder, not a pixel', async ({ page, vaultDir }) => {
    await openFromTree(page, 'empty.md');
    await page.locator('app-editor .cm-content').click();
    await page.locator('app-editor app-markdown-toolbar button[aria-label="Insert"]').click();
    await page
      .locator('app-editor app-markdown-toolbar .menu button', { hasText: 'Insert diagram' })
      .click();
    await expect(page.locator('iframe.drawio-frame')).toBeVisible({ timeout: 30000 });

    // The embed was written into the note before the diagram tab took over.
    await page.locator('app-tab-bar .tab', { hasText: 'empty.md' }).click();
    const picture = page.locator('app-editor .cm-content .lp-image img');
    await expect(picture).toBeVisible();
    await expect(picture).toHaveAttribute('src', /attachments\/diagram-.*\.drawio\.svg/);
    await expect
      .poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(240);
    const created = (fs.readdirSync(vaultDir, { recursive: true }) as string[]).filter((name) =>
      path.basename(name).startsWith('diagram-'),
    );
    expect(created).toHaveLength(1);
  });

  test('/diagram in the slash menu inserts a diagram', async ({ page }) => {
    await openFromTree(page, 'empty.md');
    await page.locator('app-editor .cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('/dia');
    const option = page.locator('.cm-tooltip-autocomplete li', { hasText: 'Diagram' });
    await expect(option).toBeVisible();
    await option.click();
    await expect(page.locator('iframe.drawio-frame')).toBeVisible({ timeout: 30000 });

    await page.locator('app-tab-bar .tab', { hasText: 'empty.md' }).click();
    await expect(page.locator('app-editor .cm-content .lp-image img')).toHaveAttribute(
      'src',
      /attachments\/diagram-.*\.drawio\.svg/,
    );
    // The typed command is gone (the embed path itself contains "/diagram-").
    await expect(page.locator('app-editor .cm-content')).not.toContainText(/\/dia(?!gram-)/);
  });

  test('a picture of one pixel keeps reachable buttons', async ({ page }) => {
    // `picture.drawio.svg` is seeded as the 1px form older builds wrote.
    await openFromTree(page, 'note.md');
    const embed = page.locator('app-editor .cm-content .lp-image').first();
    await expect(embed).toHaveClass(/lp-image-tiny/);
    const box = await embed.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(72);
    expect(box!.height).toBeGreaterThanOrEqual(32);
  });

  test('"New diagram" creates a file and opens it', async ({ page, vaultDir }) => {
    await runCommand(page, 'New diagram');

    await expect(page.locator('iframe.drawio-frame')).toBeVisible({ timeout: 30000 });
    // Beside the focused note (today's daily note), in its attachments folder.
    const created = (fs.readdirSync(vaultDir, { recursive: true }) as string[]).filter(
      (name) => name.endsWith('.drawio.svg') && path.basename(name).startsWith('diagram-'),
    );
    expect(created).toHaveLength(1);
  });
});
