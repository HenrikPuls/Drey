/**
 * The four toolbar glyphs, inlined as SVG. The plugin must not depend on
 * the shell's Angular `app-icon` (ADR-0044 rule 2), so these are the same
 * Lucide paths the host's vendored set carries (`src/app/icons/icon.ts`),
 * re-expressed as plain SVG elements. Keep them in step if the host set
 * ever redraws one.
 */
export type ToolbarIconName = 'chevron-left' | 'chevron-right' | 'x' | 'refresh-cw';

const PATHS: Record<ToolbarIconName, readonly string[]> = {
  'chevron-left': ['m15 18-6-6 6-6'],
  'chevron-right': ['m9 18 6-6-6-6'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  'refresh-cw': [
    'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8',
    'M21 3v5h-5',
    'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16',
    'M3 21v-5h5',
  ],
};

export function iconSvg(name: ToolbarIconName, size: number): SVGSVGElement {
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
  for (const d of PATHS[name]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}
