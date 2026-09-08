/**
 * Builds `build/icon.ico` (and a 512px `build/icon.png`) from the supplied
 * logo `build/logo-source.png` -- cropped tight to the chipmunk "D" mark,
 * dropping the "drey" wordmark and most of the black margin. Re-run after
 * changing the source or the crop box:
 *
 *   npm run make:icon
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
await writeFile(ICO, await pngToIco(frames));
await base.clone().resize(512, 512, { fit: 'cover' }).png().toFile(PNG);

console.log(`build/icon.ico (${ICO_SIZES.join(', ')} px) + build/icon.png written`);
