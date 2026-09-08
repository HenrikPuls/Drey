/**
 * Builds the app icons from the supplied logo `build/logo-source.png` --
 * cropped tight to the chipmunk "D" mark, dropping the "drey" wordmark and
 * most of the black margin. Writes:
 *   - build/icon.ico     electron-builder win.icon (exe + installer)
 *   - build/icon.png     512px, the BrowserWindow / taskbar icon
 *   - public/favicon.ico the renderer favicon
 *   - public/icon.png    512px, the in-app mark (titlebar, About)
 * Re-run after changing the source or the crop box:  npm run make:icon
 *
 * Uses `sharp` (prebuilt binary, build-time only) + `png-to-ico`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(root, 'build', 'logo-source.png');
const ICO = path.join(root, 'build', 'icon.ico');
const PNG = path.join(root, 'build', 'icon.png');
const FAVICON = path.join(root, 'public', 'favicon.ico');
const PUBLIC_PNG = path.join(root, 'public', 'icon.png');

// Tight square around the mark in the 1254x1254 source (tune by eye).
const CROP = { left: 336, top: 236, width: 540, height: 540 };
// The source's near-black background, so a resized frame has no seam.
const BG = { r: 13, g: 13, b: 13, alpha: 1 };
const ICO_SIZES = [256, 128, 64, 48, 32, 16];

const base = sharp(await readFile(SOURCE))
  .extract(CROP)
  .flatten({ background: BG });

const frames = await Promise.all(
  ICO_SIZES.map((size) => base.clone().resize(size, size, { fit: 'cover' }).png().toBuffer()),
);
const ico = await pngToIco(frames);
await writeFile(ICO, ico);
await writeFile(FAVICON, ico);
const png512 = await base.clone().resize(512, 512, { fit: 'cover' }).png().toBuffer();
await writeFile(PNG, png512);
await writeFile(PUBLIC_PNG, png512);

console.log(
  `build/icon.ico + build/icon.png + public/favicon.ico + public/icon.png written (${ICO_SIZES.join(
    ', ',
  )} px)`,
);
