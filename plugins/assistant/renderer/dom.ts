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
  | 'search';

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
};

export function icon(name: IconName, size = 12): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
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
