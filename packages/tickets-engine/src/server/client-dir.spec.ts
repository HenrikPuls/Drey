import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clientDirOf } from './client-dir';

describe('clientDirOf', () => {
  let root = '';
  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'engine-client-dir-'));
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('serves the built Mission Control app when it is there', async () => {
    const built = path.join(root, 'built');
    await fsp.mkdir(built);
    await fsp.writeFile(path.join(built, 'index.html'), '<html></html>', 'utf8');
    expect(await clientDirOf(built, path.join(root, 'legacy'))).toBe(built);
  });

  it('falls back to the legacy client when the app was never built, instead of failing the start', async () => {
    const legacy = path.join(root, 'legacy');
    expect(await clientDirOf(path.join(root, 'missing'), legacy)).toBe(legacy);
  });
});
