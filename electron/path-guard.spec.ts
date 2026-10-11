import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { isPathInside } from './path-guard';

describe('isPathInside', () => {
  const root = path.resolve('some', 'root', 'plugins');

  it('accepts the root and anything under it', () => {
    expect(isPathInside(root, root)).toBe(true);
    expect(isPathInside(root, path.join(root, 'tags', 'renderer', 'index.js'))).toBe(true);
    expect(isPathInside(root, path.join(root, '..notes.md'))).toBe(true);
  });

  it('rejects a parent and a sibling sharing the prefix', () => {
    expect(isPathInside(root, path.dirname(root))).toBe(false);
    expect(isPathInside(root, `${root}-evil`)).toBe(false);
    expect(isPathInside(root, path.join(`${root}-evil`, 'index.js'))).toBe(false);
  });

  it.runIf(process.platform === 'win32')('rejects a path on another drive', () => {
    expect(isPathInside('C:\\app\\dist', 'D:\\app\\dist\\index.html')).toBe(false);
  });
});
