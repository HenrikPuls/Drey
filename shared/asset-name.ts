/**
 * Naming for binary assets pasted or dropped into an editor -- images that
 * are saved into an `attachments/` folder beside the note that references
 * them (ADR-0024). Pure and dependency-free: the main process (which does
 * the write and the hashing) and the Vitest suite both use it.
 *
 * A name is `YYYY-MM-DD-HHmmss-<6 hex>.<ext>` -- sortable by time and
 * human-readable, with a short content-hash suffix so two pastes in the
 * same second don't collide and no dedupe lookup is needed.
 */

/** The folder, relative to a note's own directory, that its assets go into. */
export const ATTACHMENTS_DIR = 'attachments';

/** MIME type -> file extension (no dot) for the image types a paste can carry. */
const IMAGE_EXT_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/tiff': 'tif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

/** Bare extensions we also accept off a dropped file's name. */
const IMAGE_FILE_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['png', 'png'],
  ['jpg', 'jpg'],
  ['jpeg', 'jpg'],
  ['gif', 'gif'],
  ['webp', 'webp'],
  ['svg', 'svg'],
  ['bmp', 'bmp'],
  ['avif', 'avif'],
  ['tif', 'tif'],
  ['tiff', 'tif'],
  ['ico', 'ico'],
]);

/**
 * The file extension (no dot, lower-case) for a pasted/dropped image, from
 * its MIME type (`image/png`) or a source filename (`Shot.PNG`). `null`
 * when it is not a recognised image type -- the caller then leaves the
 * paste to the browser's default handler.
 */
export function imageExtension(mimeOrFilename: string): string | null {
  const value = mimeOrFilename.trim().toLowerCase();
  if (!value) {
    return null;
  }
  if (value in IMAGE_EXT_BY_MIME) {
    return IMAGE_EXT_BY_MIME[value];
  }
  const dot = value.lastIndexOf('.');
  if (dot !== -1 && dot < value.length - 1) {
    return IMAGE_FILE_EXTENSIONS.get(value.slice(dot + 1)) ?? null;
  }
  return null;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * `YYYY-MM-DD-HHmmss` in local time -- the readable half of an asset name.
 * Local rather than UTC so it lines up with when the user actually pasted,
 * the same convention the daily-note file names use.
 */
export function assetTimestamp(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * The full asset file name `<timestamp>-<6 hex>.<ext>`. `hashHex` is a hex
 * digest of the bytes (the main process passes a full SHA-256; any hex
 * string of 6+ chars works). Throws on a malformed extension or a
 * too-short hash so a bad name can never reach disk.
 */
export function assetFileName(input: { date: Date; hashHex: string; ext: string }): string {
  const ext = input.ext.replace(/^\.+/, '').toLowerCase();
  if (!/^[a-z0-9]+$/.test(ext)) {
    throw new Error(`Invalid asset extension: ${JSON.stringify(input.ext)}`);
  }
  const short = input.hashHex.toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 6);
  if (short.length < 6) {
    throw new Error('assetFileName needs at least 6 hex digits of hash');
  }
  return `${assetTimestamp(input.date)}-${short}.${ext}`;
}

/** Windows-reserved device names -- illegal as a file base name even with an extension. */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * Whether `mimeOrFilename` names a PDF: the MIME type (`application/pdf`)
 * or a filename/path whose extension (case-insensitive) is `pdf`. Returns
 * the extension (`'pdf'`) or `null` -- the same contract as
 * {@link imageExtension}. Deliberately separate from the image sets so the
 * image branch of the drop cascade, `saveAssetFromUrl` and the OCR image
 * scanning keep working unchanged (ADR-0052).
 */
export function pdfExtension(mimeOrFilename: string): string | null {
  const value = mimeOrFilename.trim().toLowerCase();
  if (!value) {
    return null;
  }
  if (value === 'application/pdf') {
    return 'pdf';
  }
  const dot = value.lastIndexOf('.');
  const slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  if (dot > slash && dot < value.length - 1) {
    return value.slice(dot + 1) === 'pdf' ? 'pdf' : null;
  }
  return null;
}

/**
 * The file name a *name-preserving* asset keeps (ADR-0052): the source
 * name's base name with the characters Windows forbids in a file name
 * replaced by `-`, trailing dots/spaces removed from the stem, and the
 * given extension enforced (any existing extension is replaced, so a
 * mislabelled file still lands under the right one). A stem that
 * sanitises away to nothing (or a reserved device name like `con`, which
 * Windows forbids even before an extension) falls back to
 * `asset.<ext>`. The caller appends `-2`, `-3`, ... on a collision --
 * same contract as the hash-named assets.
 */
export function sanitizedAssetFileName(fileName: string, ext: string): string {
  const cleanExt = ext.replace(/^\.+/, '').toLowerCase();
  const base = fileName.slice(Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\')) + 1);
  const sanitized = base.replace(/[<>:"/\\|?*]/g, '-');
  const dot = sanitized.lastIndexOf('.');
  const stem = (dot > 0 ? sanitized.slice(0, dot) : sanitized).replace(/[. ]+$/, '');
  if (!stem || RESERVED_NAMES.has(stem.toLowerCase())) {
    return `asset.${cleanExt}`;
  }
  return `${stem}.${cleanExt}`;
}
