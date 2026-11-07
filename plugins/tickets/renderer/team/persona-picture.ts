const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The persona's picture, one drawing everywhere (fidelity ruling O8): the Crew
 * cards, the ticket card and the Parts rows. The persona colour, a head and
 * shoulders; a persona without a colour draws on the border grey.
 */
export function personaPictureNode(color: string, title: string, size = 20): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', title);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'desk-silhouette');
  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('width', '24');
  bg.setAttribute('height', '24');
  bg.setAttribute('fill', color === '' ? 'var(--border)' : color);
  const head = document.createElementNS(SVG_NS, 'circle');
  head.setAttribute('cx', '12');
  head.setAttribute('cy', '9.5');
  head.setAttribute('r', '4.2');
  const body = document.createElementNS(SVG_NS, 'path');
  body.setAttribute('d', 'M3.5 24c0-5 3.8-8 8.5-8s8.5 3 8.5 8z');
  for (const part of [head, body]) {
    part.setAttribute('fill', 'var(--on-pastel)');
    part.setAttribute('fill-opacity', '0.78');
  }
  svg.append(bg, head, body);
  return svg;
}
