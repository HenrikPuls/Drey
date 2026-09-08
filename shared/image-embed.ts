/**
 * Obsidian-style inline image sizing: a trailing `|<width>` or
 * `|<width>x<height>` on a Markdown image's alt text sets its display size
 * (`![a diagram|300](img/x.png)`). Pure and dependency-free so the Live
 * Preview widget layer and the Vitest suite share one parser, and the
 * resize handle (`live-preview/block-render.ts`) can rewrite the alt text
 * deterministically.
 */

export interface ImageEmbed {
  /** The alt text with any size suffix stripped. */
  alt: string;
  /** Display width in CSS px, or `null` when none was given. */
  width: number | null;
  /** Display height in CSS px, or `null` (only ever set alongside `width`). */
  height: number | null;
}

/** Bounds a resized width lands in -- also what `setEmbedWidth` clamps to. */
export const EMBED_WIDTH_MIN = 16;
export const EMBED_WIDTH_MAX = 10000;

const WIDTH_RE = /^(\d+)$/;
const WIDTH_HEIGHT_RE = /^(\d+)x(\d+)$/;

/**
 * Splits an Image node's raw alt text on a trailing `|<digits>` /
 * `|<digits>x<digits>`. The size token is whatever follows the **last**
 * `|`, so an alt that legitimately contains `|` (`a | b`) keeps it as long
 * as the final segment isn't a bare number. A zero or non-integer token is
 * treated as ordinary alt text, not a size.
 */
export function parseImageEmbed(rawAlt: string): ImageEmbed {
  const bar = rawAlt.lastIndexOf('|');
  if (bar === -1) {
    return { alt: rawAlt, width: null, height: null };
  }
  const token = rawAlt.slice(bar + 1).trim();
  const prefix = rawAlt.slice(0, bar);

  const w = WIDTH_RE.exec(token);
  if (w) {
    const width = Number(w[1]);
    return width > 0 ? { alt: prefix, width, height: null } : { alt: rawAlt, width: null, height: null };
  }
  const wh = WIDTH_HEIGHT_RE.exec(token);
  if (wh) {
    const width = Number(wh[1]);
    const height = Number(wh[2]);
    return width > 0 && height > 0
      ? { alt: prefix, width, height }
      : { alt: rawAlt, width: null, height: null };
  }
  return { alt: rawAlt, width: null, height: null };
}

/** Clamp + integer-round a width to the resize bounds. */
export function clampEmbedWidth(value: number): number {
  const n = Number.isFinite(value) ? value : EMBED_WIDTH_MIN;
  return Math.round(Math.min(EMBED_WIDTH_MAX, Math.max(EMBED_WIDTH_MIN, n)));
}

/**
 * Rewrites `rawAlt` so it carries exactly `|<width>` (clamped, integer).
 * An existing `|W` or `|WxH` suffix is replaced -- the height is dropped
 * (the drag handle is width-only; aspect ratio comes from the image
 * itself). The alt text before the suffix is preserved verbatim.
 */
export function setEmbedWidth(rawAlt: string, width: number): string {
  const { alt } = parseImageEmbed(rawAlt);
  return `${alt}|${clampEmbedWidth(width)}`;
}
