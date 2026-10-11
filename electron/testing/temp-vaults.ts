/**
 * Two real vault folders plus a user-data folder holding their registry,
 * all under one temp directory -- for main-process specs that run a real
 * `VaultManager` instead of faking the file system.
 *
 * The spec mocks `electron` so that `app.getPath('userData')` returns
 * `userData` (a `vi.mock` call cannot live here, it is per spec file).
 *
 * Spec-only: nothing in the app imports this.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface TempVaults {
  /** What `app.getPath('userData')` must return. */
  readonly userData: string;
  /** Root folder of vault `va`, the active one. */
  readonly a: string;
  /** Root folder of vault `vb`. */
  readonly b: string;
  /** Writes a file (and its folders) into a vault root. */
  put(root: string, rel: string, content?: string): void;
  read(root: string, rel: string): string;
  exists(root: string, rel: string): boolean;
  dispose(): void;
}

export function createTempVaults(): TempVaults {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-spec-'));
  const userData = path.join(tmp, 'user-data');
  const a = path.join(tmp, 'vault-a');
  const b = path.join(tmp, 'vault-b');
  for (const dir of [userData, a, b]) {
    fs.mkdirSync(dir);
  }
  fs.writeFileSync(
    path.join(userData, 'vault-config.json'),
    JSON.stringify({
      version: 2,
      vaults: [
        { id: 'va', name: 'A', path: a },
        { id: 'vb', name: 'B', path: b },
      ],
      activeVaultId: 'va',
    }),
  );
  return {
    userData,
    a,
    b,
    put(root, rel, content = '') {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    },
    read: (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8'),
    exists: (root, rel) => fs.existsSync(path.join(root, rel)),
    dispose: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}
