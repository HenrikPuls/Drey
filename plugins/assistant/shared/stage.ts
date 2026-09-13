/**
 * Staging rules for attaching EXTERNAL files (not yet in the vault) to a
 * chat's context (ADR-0048 "paths, not bodies": the file is copied into
 * the vault first, then referenced by path like any other attachment).
 * Pure classification/naming so the unit suite covers the routing; the
 * fs/dialog work lives in the plugin main's `chat:attachExternal` handler.
 */

/** Text-ish extensions copied name-preserving as file attachments. */
export const STAGE_TEXT_EXTENSIONS = new Set([
  'md',
  'markdown',
  'mdx',
  'txt',
  'csv',
  'json',
  'ts',
  'js',
  'py',
  'c',
  'h',
  'cpp',
  'cs',
  'xml',
  'yaml',
  'yml',
  'log',
]);

/** Image extensions staged through the hash-named asset path (ADR-0024). */
export const STAGE_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

export type StagedFileKind = 'file' | 'image';

/** Lowercased extension of `path`/name (`''.log` → 'log'), no dot. */
export function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

/** How an external file is staged, or `null` when it is not attachable. */
export function externalFileKind(path: string): StagedFileKind | null {
  const ext = extensionOf(path);
  if (STAGE_IMAGE_EXTENSIONS.has(ext)) {
    return 'image';
  }
  if (STAGE_TEXT_EXTENSIONS.has(ext)) {
    return 'file';
  }
  return null;
}

/**
 * First free name for a staged file inside its target folder:
 * `report.md`, `report-2.md`, `report-3.md` … (case-insensitive against
 * the existing sibling names — the vault's filesystems are case-insensitive
 * in practice on Windows/macOS).
 */
export function uniqueStagedName(fileName: string, existing: Iterable<string>): string {
  const taken = new Set([...existing].map((name) => name.toLowerCase()));
  if (!taken.has(fileName.toLowerCase())) {
    return fileName;
  }
  const dot = fileName.lastIndexOf('.');
  const stem = dot === -1 ? fileName : fileName.slice(0, dot);
  const ext = dot === -1 ? '' : fileName.slice(dot);
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}

/**
 * Where staged files land: `attachments/` beside the reference note —
 * the same convention as the editor's image paste (ADR-0024).
 */
export function stagedAttachmentsDir(referenceNote: string): string {
  const slash = referenceNote.lastIndexOf('/');
  const dir = slash === -1 ? '' : referenceNote.slice(0, slash);
  return dir === '' ? 'attachments' : `${dir}/attachments`;
}
