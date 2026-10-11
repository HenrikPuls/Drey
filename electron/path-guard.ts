import * as path from 'node:path';

/**
 * Whether `target` is `rootDir` itself or lies under it. Both are expected
 * normalised and absolute.
 *
 * `path.relative`-based rather than a `startsWith` on the strings: a
 * sibling that merely shares the prefix (`C:\x\plugins-evil` against a root
 * of `C:\x\plugins`) is outside, and so is a path on another drive, which
 * `path.relative` returns as an absolute path.
 */
export function isPathInside(rootDir: string, target: string): boolean {
  const relative = path.relative(rootDir, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
