/**
 * Turns the supplied pink-backdrop logo art `handoff/image0.jpeg` into the
 * transparent `build/logo-source.png` that `make-icon.mjs` consumes.
 *
 * Two keying tests, both global (no connectivity logic -- the mark encloses
 * pink regions a border flood fill could never reach):
 *   1. hard key: pixels within T_BG RGB distance of the border-median pink
 *      are pure backdrop and go fully transparent;
 *   2. hue key: everything else is scored by P = min(R-G, B-G), which
 *      measures exactly how much pink a pixel carries. The art's own colours
 *      never trip it -- warm browns fail on B-G (negative), the cream
 *      outline tops out around P=13 -- while any real pink blend scores
 *      60..244. Alpha = 1 - P/P_PINK, i.e. the foreground's own coverage,
 *      and the pink share is unmixed out of the colour, so the JPEG-soft
 *      edges (up to ~6 px wide here) key out with no magenta fringe.
 *
 * `handoff/` is gitignored -- the tracked `build/logo-source.png` is the
 * canonical art afterwards; this script records how it was made.
 * Re-run after changing the source art:  node scripts/make-logo-transparent.mjs
 *
 * Uses `sharp` (prebuilt binary, build-time only).
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp-images';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(root, 'handoff', 'image0.jpeg');
const TARGET = path.join(root, 'build', 'logo-source.png');

const T_BG = 50; // RGB distance below which a pixel IS pure pink backdrop
const P_KEEP = 20; // hue score below which a pixel counts as clean mark art

const clamp255 = (v) => Math.max(0, Math.min(255, v));

const { data, info } = await sharp(await readFile(SOURCE))
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const { width: w, height: h } = info;

// Reference pink: per-channel median of the border pixels (the mark never
// touches the frame, so the whole border is backdrop).
const border = [];
for (let x = 0; x < w; x++) border.push(x, x + (h - 1) * w);
for (let y = 0; y < h; y++) border.push(y * w, w - 1 + y * w);
const pick = (i, c) => data[i * 4 + c];
const pink = [0, 1, 2].map((c) => {
  const s = border.map((i) => pick(i, c)).sort((a, b) => a - b);
  return s[s.length >> 1];
});
// Pink's own hue score: the denominator of the coverage estimate.
const P_PINK = Math.min(pink[0] - pink[1], pink[2] - pink[1]);

const dist2 = (i) => {
  const dr = pick(i, 0) - pink[0];
  const dg = pick(i, 1) - pink[1];
  const db = pick(i, 2) - pink[2];
  return dr * dr + dg * dg + db * db;
};

let keyed = 0;
for (let i = 0; i < w * h; i++) {
  const o = i * 4;
  const hue = Math.min(pick(i, 0) - pick(i, 1), pick(i, 2) - pick(i, 1));
  if (dist2(i) < T_BG * T_BG || hue > P_PINK) {
    // Pure (or more-than-pure) pink: fully transparent. Zero the RGB too, so
    // no pink energy can bleed back in during the icon resizes.
    data[o] = data[o + 1] = data[o + 2] = data[o + 3] = 0;
    keyed++;
    continue;
  }
  if (hue <= P_KEEP) continue; // clean mark art, leave untouched
  // Partially pink: alpha = the foreground's own coverage, and pull the pink
  // share out of the colour (px = c*pink + (1-c)*fg  =>  solve for fg).
  const c = Math.min(1, hue / P_PINK);
  const a = Math.round(255 * (1 - c));
  data[o + 3] = a;
  for (let ch = 0; ch < 3; ch++)
    data[o + ch] = clamp255(Math.round((data[o + ch] - c * pink[ch]) / (1 - c)));
}

const png = await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
await writeFile(TARGET, png);

console.log(
  `build/logo-source.png written (${w}x${h}, pink ${pink.join(', ')}, hue ${P_PINK}; ` +
    `${keyed} px keyed)`,
);
