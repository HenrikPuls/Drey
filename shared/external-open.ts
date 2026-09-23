/**
 * Files the OS may hand to Drey (Explorer "Open with" / a default-program
 * association, ADR-0054). Shared by main (argv filtering, the read gate) and
 * the renderer (the tab's Markdown-ness); `electron-builder.yml`'s
 * `fileAssociations` lists the same extensions -- keep the two in step.
 */
export const EXTERNAL_OPEN_EXTENSIONS: readonly string[] = ['md', 'markdown', 'mdx', 'txt'];

/** Whether `filePath` ends in an extension Drey registers for (case-insensitive). */
export function isExternalOpenPath(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) {
    return false;
  }
  return EXTERNAL_OPEN_EXTENSIONS.includes(filePath.slice(dot + 1).toLowerCase());
}

/**
 * Tab-key prefix of an external (out-of-vault) document. Same `://`
 * convention as the plugin doc kinds (`browser://<n>`), so the key space
 * stays collision-free against `vaultId::path` and bare scratch names.
 */
export const EXTERNAL_KEY_PREFIX = 'external://';

/** The tab key of the external document at absolute path `absolutePath`. */
export function externalDocKey(absolutePath: string): string {
  return EXTERNAL_KEY_PREFIX + absolutePath.replace(/\\/g, '/');
}
