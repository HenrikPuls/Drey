/**
 * Builds the app icons from the supplied logo `build/logo-source.png` --
 * a transparent, roughly framed rendering of the app mark. The mark
 * is trimmed to its bounding box and recentred near edge-to-edge in a
 * square (Windows/macOS/Linux and the taskbar all add their own padding),
 * kept fully transparent, then written out as:
 *   - build/icon.ico     electron-builder win.icon (exe + installer) + the
 *                        BrowserWindow / taskbar icon
 *   - build/icon.png     512 px -- packaged fallback (Linux)
 *   - public/favicon.ico the renderer <link rel="icon"> (Electron never
 *                        paints it, kept in sync for a browser context)
 *   - public/icon.png    512 px -- the in-app mark (titlebar, About)
 * A theme with its own mark (req-42, `shared/app-icon.ts`) has a second
 * source, `build/logo-source-<variant>.png`, written the same way as
 * `build/icon-<variant>.ico` / `.png` and `public/icon-<variant>.png` --
 * the window / taskbar icon and the in-app mark while that theme is on.
 * No favicon: the exe, the installer and the browser tab keep the default.
 * Re-run after changing the source art:  npm run make:icon
 * The exe/installer only pick these up on the next `npm run pack`; when
 * Explorer then still shows the old icon for the same-named artifact, that
 * is the Windows icon cache (verify via ExtractAssociatedIcon, refresh with
 * `ie4uinit.exe -show`), not a stale build.
 *
 * Uses `sharp` (prebuilt binary, build-time only) + `png-to-ico`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp-images';
import pngToIco from 'png-to-ico';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(root, 'build');
const PUBLIC = path.join(root, 'public');
// Keep in step with `AppIconVariant` in shared/app-icon.ts.
const THEMED_VARIANTS = ['cyberpunk'];

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };
const ICO_SIZES = [256, 128, 64, 48, 32, 16];
// The renderer favicon is fetched on every window load — 16/32/48 keep it
// a few KB instead of the full multi-size exe icon (milestone 61).
const FAVICON_SIZES = [48, 32, 16];
const CANVAS = 1024; // working square before the final resizes
// Tiny breathing room only so the trim's anti-aliased edge is not clipped;
// the OS shells add the real padding around a taskbar / dock icon.
const MARGIN = 0.02;

/**
 * Trims the transparent border off the source art, then fits the mark
 * near edge-to-edge into a centred square; returns a resizer over it.
 * `trimThreshold` is how far a pixel must differ from the corner to count
 * as part of the mark -- raised for art with a soft glow, whose faint
 * outer halo would otherwise shrink the mark inside its square.
 */
async function loadMark(source, trimThreshold) {
  const trimmed = await sharp(await readFile(source))
    .ensureAlpha()
    .trim({ threshold: trimThreshold })
    .toBuffer();

  const inner = Math.round(CANVAS * (1 - 2 * MARGIN));
  const pad = Math.round((CANVAS - inner) / 2);
  const markPng = await sharp(
    await sharp(trimmed)
      .resize(inner, inner, { fit: 'contain', background: TRANSPARENT })
      .toBuffer(),
  )
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: TRANSPARENT })
    .png()
    .toBuffer();

  return (size) =>
    sharp(markPng).resize(size, size, { fit: 'contain', background: TRANSPARENT }).png().toBuffer();
}

const frame = await loadMark(path.join(BUILD, 'logo-source.png'), 12);
await writeFile(path.join(BUILD, 'icon.ico'), await pngToIco(await Promise.all(ICO_SIZES.map(frame))));
await writeFile(
  path.join(PUBLIC, 'favicon.ico'),
  await pngToIco(await Promise.all(FAVICON_SIZES.map(frame))),
);
await writeFile(path.join(BUILD, 'icon.png'), await frame(512));
await writeFile(path.join(PUBLIC, 'icon.png'), await frame(512));

for (const variant of THEMED_VARIANTS) {
  const themed = await loadMark(path.join(BUILD, `logo-source-${variant}.png`), 40);
  await writeFile(
    path.join(BUILD, `icon-${variant}.ico`),
    await pngToIco(await Promise.all(ICO_SIZES.map(themed))),
  );
  await writeFile(path.join(BUILD, `icon-${variant}.png`), await themed(512));
  await writeFile(path.join(PUBLIC, `icon-${variant}.png`), await themed(512));
}

console.log(
  `build/icon.ico + build/icon.png + public/favicon.ico + public/icon.png written, plus the ${THEMED_VARIANTS.join(
    ', ',
  )} set (${ICO_SIZES.join(', ')} px)`,
);
