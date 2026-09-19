/**
 * Tag prefix colors: a configured prefix (a `/`-namespace like `proj/`) tints
 * every tag under it, everywhere tags render (editor pills, chips in the
 * entry drawer and the dock panels, completion options). Configured on the
 * Tags plugin's settings page; resolved here, base-side, so the same rule
 * colors all surfaces.
 *
 * Resolution: the **longest** configured prefix wins (`proj/frontend` beats
 * `proj` for `#proj/frontend/api`). Unconfigured tags get a deterministic
 * auto color keyed on the tag's first segment, so all of `#xyz/*` shares one
 * hue and the coloring stays stable across sessions without any config.
 */

import { TAG_NAME_SOURCE } from './tag-grammar.js';
import type { TagPrefixStyle } from './plugin-api/search-types.js';

export type { TagPrefixStyle };

/** How a tag's color came about — surfaced in tests and tooltips. */
export interface TagStyleInfo {
  color: string;
  origin: 'configured' | 'auto';
}

/**
 * Curated for the dark shell: the `ACCENT_PRESETS` hue family (see
 * `shared/config/schema.ts`) plus four extra mid-saturation hues, all
 * readable as a chip/pill fill on `--bg-editor`.
 */
export const TAG_AUTO_PALETTE: readonly string[] = [
  '#c96442', // terracotta
  '#7d8f6e', // sage
  '#6e83a0', // slate blue
  '#8b7fa8', // violet
  '#c98a3c', // amber
  '#4f9a90', // teal
  '#b06a7a', // rose
  '#5a94a8', // cyan
  '#8f9a55', // olive
  '#9a6a9e', // plum
];

/**
 * Normalizes a user-entered prefix: trimmed, lower-cased, leading `#` and
 * trailing `/` stripped. Returns `null` when the remainder is empty or not
 * a valid (possibly multi-segment) tag-name prefix per the grammar.
 */
export function normalizeTagPrefix(raw: string): string | null {
  const cleaned = raw.trim().toLowerCase().replace(/^#/, '').replace(/\/+$/, '');
  if (cleaned === '') {
    return null;
  }
  return new RegExp(`^${TAG_NAME_SOURCE}$`, 'u').test(cleaned) ? cleaned : null;
}

/**
 * Resolves the color for one tag (lower-case, no `#`). Longest configured
 * prefix matching the whole segment chain wins; otherwise a stable palette
 * color keyed on the first segment.
 */
export function resolveTagStyle(tag: string, prefixes: readonly TagPrefixStyle[]): TagStyleInfo {
  let best: TagPrefixStyle | null = null;
  for (const p of prefixes) {
    if (matchesPrefix(tag, p.prefix) && (best === null || p.prefix.length > best.prefix.length)) {
      best = p;
    }
  }
  if (best !== null) {
    return { color: best.color, origin: 'configured' };
  }
  const key = tag.split('/', 1)[0] || tag;
  return { color: TAG_AUTO_PALETTE[djb2(key) % TAG_AUTO_PALETTE.length], origin: 'auto' };
}

/**
 * Chip/pill fills for a tag color, mirroring the accent token mixes
 * (`--accent-text` / `--accent-surface` in `src/styles.css`): a light-tinted
 * foreground over a translucent same-hue background.
 */
export function tagChipColors(color: string): { fg: string; bg: string } {
  return {
    fg: `color-mix(in srgb, ${color} 58%, #f2efe9)`,
    bg: `color-mix(in srgb, ${color} 15%, transparent)`,
  };
}

/** `tag === prefix` or `tag` extends it at a `/` boundary. */
function matchesPrefix(tag: string, prefix: string): boolean {
  return tag === prefix || tag.startsWith(`${prefix}/`);
}

/** djb2 — tiny, stable across sessions and platforms; plenty for hue pick. */
function djb2(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = (h * 33 + text.charCodeAt(i)) >>> 0;
  }
  return h;
}
