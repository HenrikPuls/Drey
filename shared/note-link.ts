/**
 * Computes the link path to write into a note when referencing another
 * file already in the vault -- e.g. dragging `assets/logo.png` from the
 * Files panel into `projects/foo.md` should insert `![](../assets/logo.png)`.
 * Pure and dependency-free; the drop handler (`src/app/editor/image-paste.ts`)
 * and the Vitest suite share it.
 *
 * Both arguments are vault-root-relative, forward-slash, already
 * normalised (no leading `/`, no `.` / `..` segments) -- the contract of
 * `VaultFileEntry.relativePath` and `EditorService.openPath()`. A note at
 * the vault root gets the target back unchanged; the same directory gets
 * the bare filename.
 */
export function noteRelativeLink(fromNotePath: string, toAssetPath: string): string {
  const cut = fromNotePath.lastIndexOf('/');
  if (cut === -1) {
    return toAssetPath;
  }
  const fromSegs = fromNotePath.slice(0, cut).split('/');
  const toSegs = toAssetPath.split('/');
  let i = 0;
  while (i < fromSegs.length && i < toSegs.length - 1 && fromSegs[i] === toSegs[i]) {
    i++;
  }
  const ups = fromSegs.length - i;
  return [...Array<string>(ups).fill('..'), ...toSegs.slice(i)].join('/');
}
