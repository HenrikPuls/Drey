/**
 * Diagram files (ADR-0064): which vault files are diagrams, how a diagram
 * tab is keyed, and what a new, empty diagram looks like on disk.
 *
 * Three formats. `.drawio.svg` and `.drawio.png` are pictures that carry
 * the diagram -- the SVG in its root `content` attribute, the PNG in a
 * `tEXt` chunk named `mxfile` -- so they render wherever an image does.
 * `.drawio` is the plain XML file.
 */

export type DiagramFormat = 'svg' | 'png' | 'xml';
/** The formats a note can embed -- what "New diagram" may create. */
export type PictureFormat = 'svg' | 'png';

export const DIAGRAM_SUFFIX: Readonly<Record<DiagramFormat, string>> = {
  svg: '.drawio.svg',
  png: '.drawio.png',
  xml: '.drawio',
};
export const DIAGRAM_SUFFIXES: readonly string[] = Object.values(DIAGRAM_SUFFIX);
export const DEFAULT_PICTURE_FORMAT: PictureFormat = 'svg';

/** Tab keys carry a scheme so they can never collide with a vault path. */
export const DOC_KEY_PREFIX = 'drawio://';

/** The diagram format of a path, or null when it is not a diagram file. */
export function diagramFormatOf(path: string): DiagramFormat | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(DIAGRAM_SUFFIX.svg)) {
    return 'svg';
  }
  if (lower.endsWith(DIAGRAM_SUFFIX.png)) {
    return 'png';
  }
  return lower.endsWith(DIAGRAM_SUFFIX.xml) ? 'xml' : null;
}

/** A diagram that is also a picture (`.drawio.svg` / `.drawio.png`). */
export function isPictureDiagram(path: string): boolean {
  const format = diagramFormatOf(path);
  return format === 'svg' || format === 'png';
}

export function pictureFormat(value: unknown): PictureFormat {
  return value === 'png' ? 'png' : DEFAULT_PICTURE_FORMAT;
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The folder part of a vault-relative path, `''` at the vault root. */
export function dirOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

export interface DiagramRef {
  /** The diagram's vault (ADR-0051), null for the active vault. */
  readonly vaultId: string | null;
  /** Vault-relative path. */
  readonly path: string;
}

/** `drawio://<vaultId>/<path>`; an empty vault part means the active vault. */
export function docKeyFor(ref: DiagramRef): string {
  return `${DOC_KEY_PREFIX}${encodeURIComponent(ref.vaultId ?? '')}/${ref.path}`;
}

export function parseDocKey(key: string): DiagramRef | null {
  if (!key.startsWith(DOC_KEY_PREFIX)) {
    return null;
  }
  const rest = key.slice(DOC_KEY_PREFIX.length);
  const cut = rest.indexOf('/');
  if (cut === -1 || cut === rest.length - 1) {
    return null;
  }
  let vaultId: string;
  try {
    vaultId = decodeURIComponent(rest.slice(0, cut));
  } catch {
    return null;
  }
  return { vaultId: vaultId === '' ? null : vaultId, path: rest.slice(cut + 1) };
}

/**
 * The picture diagram behind an image element's
 * `drey-asset://<vaultId>/asset/<path>` URL, or null when the URL is not a
 * vault asset or not a diagram.
 */
export function diagramFromAssetUrl(url: string): DiagramRef | null {
  if (!url.startsWith('drey-asset://')) {
    return null;
  }
  let path: string;
  let vaultId: string;
  try {
    const parsed = new URL(url);
    vaultId = decodeURIComponent(parsed.hostname);
    path = parsed.pathname
      .replace(/^\/asset\/?/, '')
      .replace(/^\/+/, '')
      .split('/')
      .map(decodeURIComponent)
      .join('/');
  } catch {
    return null;
  }
  if (path === '' || !isPictureDiagram(path)) {
    return null;
  }
  // The host-less legacy form parses with `asset` as the host.
  return { vaultId: vaultId === '' || vaultId === 'asset' ? null : vaultId, path };
}

/** Resolves `.` / `..` segments; null when the path leaves the vault. */
function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (out.length === 0) {
        return null;
      }
      out.pop();
    } else {
      out.push(segment);
    }
  }
  return out.join('/');
}

/**
 * The picture diagrams a Markdown line embeds (`![alt](path)`), as
 * vault-relative candidate paths in the order the image embed resolves
 * them: relative to the note's folder first, then to the vault root.
 * Used when a right-click lands on the embed's source or beside a very
 * small picture rather than on the picture itself.
 */
export function diagramCandidatesInLine(line: string, notePath: string): string[] {
  const found = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))/.exec(line);
  const raw = found?.[1] ?? found?.[2];
  if (raw === undefined || /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    return [];
  }
  let reference: string;
  try {
    reference = decodeURIComponent(raw);
  } catch {
    reference = raw;
  }
  if (!isPictureDiagram(reference)) {
    return [];
  }
  const dir = dirOf(notePath);
  const candidates = [
    normalizePath(dir === '' ? reference : `${dir}/${reference}`),
    normalizePath(reference),
  ];
  return [...new Set(candidates.filter((path): path is string => path !== null && path !== ''))];
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `diagram-20261010-203015.drawio.svg` -- sortable, unique to the second. */
export function newDiagramName(now: Date, format: PictureFormat): string {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `diagram-${date}-${time}${DIAGRAM_SUFFIX[format]}`;
}

/**
 * Where a diagram created from a note goes: the `attachments/` folder
 * beside that note (the ADR-0024 rule for pasted images), the vault root's
 * when the note has no folder. `reference` is what the note's `![](…)` holds.
 */
export function newDiagramTarget(
  notePath: string | null,
  now: Date,
  format: PictureFormat,
): { path: string; reference: string } {
  const reference = `attachments/${newDiagramName(now, format)}`;
  const dir = notePath === null ? '' : dirOf(notePath);
  return { path: dir === '' ? reference : `${dir}/${reference}`, reference };
}

export const EMPTY_DIAGRAM_XML =
  '<mxfile><diagram name="Page-1"><mxGraphModel><root>' +
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '</root></mxGraphModel></diagram></mxfile>';

function escapeAttribute(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * What a diagram looks like before it is first drawn: a dashed frame with
 * a caption, big enough to see and to aim at in a note. A mid grey, so it
 * reads on dark and on light backgrounds. The editor's first save replaces
 * it with the real rendering.
 */
export const PLACEHOLDER = {
  width: 240,
  height: 120,
  color: '#8a8a8a',
  text: 'Empty diagram',
} as const;

/** A valid, blank `.drawio.svg`: the placeholder picture carrying an empty diagram. */
export function emptyDiagramSvg(): string {
  const { width, height, color, text } = PLACEHOLDER;
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" ' +
    `width="${width}px" height="${height}px" viewBox="0 0 ${width} ${height}" ` +
    `content="${escapeAttribute(EMPTY_DIAGRAM_XML)}">` +
    `<rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="8" fill="none" ` +
    `stroke="${color}" stroke-width="1.5" stroke-dasharray="6 4"/>` +
    `<text x="${width / 2}" y="${height / 2 + 5}" text-anchor="middle" ` +
    `font-family="Helvetica, Arial, sans-serif" font-size="14" fill="${color}">${text}</text>` +
    '</svg>\n'
  );
}

// --- PNG ---------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** The keyword of the `tEXt` chunk draw.io stores the diagram under. */
const PNG_DIAGRAM_KEYWORD = 'mxfile';

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function latin1(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(latin1(type), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

/**
 * A valid `.drawio.png` for this diagram XML before the editor has drawn
 * it: one transparent pixel carrying the diagram the way draw.io writes it
 * (URL-encoded XML in a `tEXt` chunk).
 */
export function placeholderDiagramPng(xml: string): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, 1); // width
  view.setUint32(4, 1); // height
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  // zlib stream of one scanline: filter byte 0 + one transparent pixel.
  const pixel = Uint8Array.from([0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01]);
  const parts = [
    Uint8Array.from(PNG_SIGNATURE),
    pngChunk('IHDR', header),
    pngDiagramChunk(xml),
    pngChunk('IDAT', pixel),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * The diagram XML inside a PNG, or null when the file is not a PNG or
 * carries none -- then it is a plain picture and must not be overwritten.
 */
export function pngDiagramXml(bytes: Uint8Array): string | null {
  if (bytes.length < 8 || PNG_SIGNATURE.some((byte, i) => bytes[i] !== byte)) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const end = offset + 8 + length;
    if (end + 4 > bytes.length) {
      return null;
    }
    if (type === 'tEXt') {
      const data = bytes.subarray(offset + 8, end);
      const cut = data.indexOf(0);
      const keyword = cut === -1 ? '' : String.fromCharCode(...data.subarray(0, cut));
      if (keyword === PNG_DIAGRAM_KEYWORD) {
        let value = '';
        // Chunked: `String.fromCharCode(...big)` overflows the call stack.
        for (let i = cut + 1; i < data.length; i += 8192) {
          value += String.fromCharCode(...data.subarray(i, Math.min(i + 8192, data.length)));
        }
        try {
          return decodeURIComponent(value);
        } catch {
          return value;
        }
      }
    }
    if (type === 'IEND') {
      break;
    }
    offset = end + 4;
  }
  return null;
}

function pngDiagramChunk(xml: string): Uint8Array {
  return pngChunk('tEXt', latin1(`${PNG_DIAGRAM_KEYWORD}\0${encodeURIComponent(xml)}`));
}

/** The same PNG picture carrying `xml` as its diagram; null when not a PNG. */
export function pngWithDiagram(bytes: Uint8Array, xml: string): Uint8Array | null {
  if (bytes.length < 8 || PNG_SIGNATURE.some((byte, i) => bytes[i] !== byte)) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const end = offset + 12 + view.getUint32(offset);
    if (end > bytes.length) {
      return null;
    }
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const chunk = bytes.subarray(offset, end);
    const isDiagram =
      type === 'tEXt' &&
      String.fromCharCode(...chunk.subarray(8, 8 + PNG_DIAGRAM_KEYWORD.length + 1)) ===
        `${PNG_DIAGRAM_KEYWORD}\0`;
    if (!isDiagram) {
      parts.push(chunk);
    }
    if (type === 'IHDR') {
      parts.push(pngDiagramChunk(xml));
    }
    offset = end;
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The same SVG picture carrying `xml` as its diagram; null when not an SVG. */
export function svgWithDiagram(svg: string, xml: string): string | null {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = document.documentElement;
  if (root.nodeName.toLowerCase() !== 'svg') {
    return null;
  }
  root.setAttribute('content', xml);
  return new XMLSerializer().serializeToString(document);
}

/**
 * A picture diagram with its diagram data replaced and the pixels left as
 * they are -- what gets written when the tab closes before the editor
 * could render the latest change: the model is never lost, the picture
 * catches up on the next edit.
 */
export function pictureWithDiagram(
  picture: string | Uint8Array,
  xml: string,
): string | Uint8Array | null {
  return typeof picture === 'string' ? svgWithDiagram(picture, xml) : pngWithDiagram(picture, xml);
}

/** The placeholder picture as PNG bytes, or null where no canvas can draw (tests). */
async function placeholderPictureBytes(): Promise<Uint8Array | null> {
  const { width, height, color, text } = PLACEHOLDER;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = canvas.getContext('2d');
  } catch {
    context = null;
  }
  if (context === null) {
    return null;
  }
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 1.5;
  context.setLineDash([6, 4]);
  context.beginPath();
  context.roundRect(1, 1, width - 2, height - 2, 8);
  context.stroke();
  context.font = '14px Helvetica, Arial, sans-serif';
  context.textAlign = 'center';
  context.fillText(text, width / 2, height / 2 + 5);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  return blob === null ? null : new Uint8Array(await blob.arrayBuffer());
}

/**
 * A valid, blank `.drawio.png`: the placeholder picture carrying an empty
 * diagram. Falls back to the one-pixel form where nothing can draw.
 */
export async function emptyDiagramPng(): Promise<Uint8Array> {
  const picture = await placeholderPictureBytes().catch(() => null);
  const withDiagram = picture === null ? null : pngWithDiagram(picture, EMPTY_DIAGRAM_XML);
  return withDiagram ?? placeholderDiagramPng(EMPTY_DIAGRAM_XML);
}

// --- load / create -----------------------------------------------------------

/** The content a new file of this format starts with. */
export async function emptyDiagram(format: DiagramFormat): Promise<string | Uint8Array> {
  if (format === 'png') {
    return emptyDiagramPng();
  }
  return format === 'svg' ? emptyDiagramSvg() : `${EMPTY_DIAGRAM_XML}\n`;
}

/**
 * What the editor loads for a file's content: the embedded XML of a
 * picture diagram, the text itself for a `.drawio`. A picture without
 * diagram data yields `null` -- saving over it would destroy it.
 */
export function diagramXmlOf(format: DiagramFormat, content: string | Uint8Array): string | null {
  if (format === 'png') {
    return typeof content === 'string' ? null : pngDiagramXml(content);
  }
  if (typeof content !== 'string') {
    return null;
  }
  if (format === 'xml') {
    return content;
  }
  if (content.trim() === '') {
    return '';
  }
  const root = new DOMParser().parseFromString(content, 'image/svg+xml').documentElement;
  if (root.nodeName.toLowerCase() !== 'svg') {
    return null;
  }
  return root.getAttribute('content');
}
