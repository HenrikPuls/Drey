/** The assistant panel's DOM helpers (ADR-0044 rule 2: plugin UI is plain DOM). */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

export type IconName =
  | 'check'
  | 'arrow-up'
  | 'copy'
  | 'corner-down-left'
  | 'rotate-ccw'
  | 'wrench'
  | 'pencil'
  | 'plus'
  | 'list'
  | 'search'
  | 'history'
  | 'bubble'
  | 'rocket'
  | 'users'
  | 'x'
  | 'mic'
  | 'send'
  | 'paperclip'
  | 'pencil-line'
  | 'database'
  | 'globe'
  | 'chevron-down'
  | 'book-open';

/** The Lucide glyphs the panel uses (same paths as `src/app/icons/icon.ts`). */
const ICON_PATHS: Record<IconName, readonly string[]> = {
  check: ['M20 6 9 17l-5-5'],
  plus: ['M5 12h14', 'M12 5v14'],
  'arrow-up': ['m5 12 7-7 7 7', 'M12 19V5'],
  copy: [
    'M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z',
    'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2',
  ],
  'corner-down-left': ['M20 4v7a4 4 0 0 1-4 4H4', 'm9 10-5 5 5 5'],
  'rotate-ccw': ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5'],
  wrench: [
    'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  ],
  pencil: ['M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z'],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
  search: ['m21 21-4.34-4.34', 'M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z'],
  // The glyphs of board 9a's Assistant (docs/design/work-panel/boards/DeskClean.dc.html).
  history: ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5M12 7v5l3 2'],
  bubble: ['M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z'],
  rocket: [
    'M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.2 2.2 0 0 0-2.9-.1z',
    'M12 15l-3-3a22 22 0 0 1 2-3.9A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22.4 22.4 0 0 1-4 2z',
    'M9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5',
  ],
  users: ['M5.5 8a3.5 3.5 0 1 0 7 0 3.5 3.5 0 1 0-7 0', 'M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6'],
  x: ['M18 6L6 18M6 6l12 12'],
  mic: ['M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0z', 'M5 11a7 7 0 0 0 14 0M12 18v4'],
  send: ['M12 19V5M5 12l7-7 7 7'],
  paperclip: ['M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7'],
  'pencil-line': ['M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z'],
  database: ['M4 5a8 3 0 1 0 16 0 8 3 0 1 0-16 0', 'M4 5v14a8 3 0 0 0 16 0V5M4 12a8 3 0 0 0 16 0'],
  globe: ['M3 12a9 9 0 1 0 18 0 9 9 0 1 0-18 0', 'M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18'],
  'chevron-down': ['M6 9l6 6 6-6'],
  'book-open': [
    'M12 7v14',
    'M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z',
  ],
};

/** True when the panel draws `name` itself (the board's glyph); otherwise the host's icon set is asked. */
export function isIconName(name: string): name is IconName {
  return Object.prototype.hasOwnProperty.call(ICON_PATHS, name);
}

export function icon(name: IconName, size = 12, strokeWidth = 1.75): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICON_PATHS[name]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/** `daily/2026-09-26.md` -> `2026-09-26.md`. */
export function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

/** `daily/2026-09-26.md` -> `daily` (no trailing slash). */
export function dirName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}
