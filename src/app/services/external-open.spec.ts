import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ExternalFileGate,
  extractOpenPaths,
  locateInVaults,
} from '../../../electron/external-open';
import { externalDocKey, isExternalOpenPath } from '../../../shared/external-open';
import { OpenRequest } from '../../../shared/ipc-api';

/**
 * `electron/external-open.ts` (ADR-0054): the argv filter, the vault
 * classification and the read gate. Real temp files -- the code stats and
 * realpaths them, and a fake fs would test the fake.
 */

describe('external open (main side)', () => {
  let dir: string;

  const write = (relative: string, content = '# hi\n'): string => {
    const abs = path.join(dir, relative);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  };

  beforeEach(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drey-ext-')));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('isExternalOpenPath / externalDocKey', () => {
    it('accepts the registered extensions case-insensitively, nothing else', () => {
      for (const name of ['a.md', 'a.MARKDOWN', 'a.mdx', 'a.TXT']) {
        expect(isExternalOpenPath(name)).toBe(true);
      }
      for (const name of ['a.pdf', 'a.png', 'a', 'md', 'a.md.exe']) {
        expect(isExternalOpenPath(name)).toBe(false);
      }
    });

    it('keys an external doc under the external:// prefix with forward slashes', () => {
      expect(externalDocKey('C:\\notes\\a.md')).toBe('external://C:/notes/a.md');
    });
  });

  describe('extractOpenPaths', () => {
    it('packaged: skips the exe, keeps existing md/txt files, drops switches', () => {
      const a = write('a.md');
      const b = write('b.txt');
      const argv = ['drey.exe', '--some-flag', a, b, path.join(dir, 'missing.md'), write('c.pdf')];
      expect(extractOpenPaths(argv, { isPackaged: true, cwd: dir })).toEqual([a, b]);
    });

    it('dev: also skips the app path (`electron .`)', () => {
      const a = write('a.md');
      expect(extractOpenPaths(['electron.exe', '.', a], { isPackaged: false, cwd: dir })).toEqual([a]);
    });

    it('resolves relative arguments against the given cwd and de-duplicates', () => {
      const a = write('sub/a.md');
      const argv = ['drey.exe', path.join('sub', 'a.md'), a];
      expect(extractOpenPaths(argv, { isPackaged: true, cwd: dir })).toEqual([a]);
    });

    it('ignores a directory that merely looks like a Markdown file', () => {
      fs.mkdirSync(path.join(dir, 'folder.md'));
      expect(extractOpenPaths(['drey.exe', path.join(dir, 'folder.md')], { isPackaged: true, cwd: dir })).toEqual([]);
    });
  });

  describe('locateInVaults', () => {
    it('finds the containing vault and returns a forward-slash relative path', () => {
      const vaultRoot = path.join(dir, 'vault');
      const file = write('vault/notes/a.md');
      expect(locateInVaults([{ id: 'v1', path: vaultRoot }], file)).toEqual({ vaultId: 'v1', path: 'notes/a.md' });
    });

    it('returns null for a file outside every vault, and for the vault root itself', () => {
      const vaultRoot = path.join(dir, 'vault');
      fs.mkdirSync(vaultRoot);
      const outside = write('elsewhere/a.md');
      expect(locateInVaults([{ id: 'v1', path: vaultRoot }], outside)).toBeNull();
      expect(locateInVaults([{ id: 'v1', path: vaultRoot }], vaultRoot)).toBeNull();
    });

    it('does not treat a sibling with a shared name prefix as inside', () => {
      fs.mkdirSync(path.join(dir, 'vault'));
      const sibling = write('vault-two/a.md');
      expect(locateInVaults([{ id: 'v1', path: path.join(dir, 'vault') }], sibling)).toBeNull();
    });

    it('picks the deepest vault when vaults nest', () => {
      const file = write('outer/inner/a.md');
      const vaults = [
        { id: 'outer', path: path.join(dir, 'outer') },
        { id: 'inner', path: path.join(dir, 'outer', 'inner') },
      ];
      expect(locateInVaults(vaults, file)).toEqual({ vaultId: 'inner', path: 'a.md' });
    });
  });

  describe('ExternalFileGate', () => {
    let pushed: OpenRequest[][];
    let vaultRoot: string;
    let gate: ExternalFileGate;

    beforeEach(() => {
      pushed = [];
      vaultRoot = path.join(dir, 'vault');
      fs.mkdirSync(vaultRoot);
      gate = new ExternalFileGate(
        () => [{ id: 'v1', path: vaultRoot }],
        (requests) => pushed.push(requests),
        64,
      );
    });

    it('queues until the renderer pulls, then classifies vault vs external', () => {
      const inside = write('vault/a.md');
      const outside = write('out/b.md');
      gate.enqueue([inside, outside]);
      expect(pushed).toEqual([]); // not ready: nothing may be pushed at cold start

      expect(gate.takePending()).toEqual([
        { kind: 'vault', vaultId: 'v1', path: 'a.md' },
        { kind: 'external', path: outside },
      ]);
      expect(gate.takePending()).toEqual([]); // drained
    });

    it('pushes straight away once the renderer has pulled', () => {
      gate.takePending();
      const outside = write('out/b.md');
      gate.enqueue([outside]);
      expect(pushed).toEqual([[{ kind: 'external', path: outside }]]);
    });

    it('collapses the same file queued twice', () => {
      const outside = write('out/b.md');
      gate.enqueue([outside, outside]);
      expect(gate.takePending()).toHaveLength(1);
    });

    it('reads only files main collected from the OS', async () => {
      const outside = write('out/b.md', 'hello');
      const stranger = write('out/secret.md', 'nope');
      gate.enqueue([outside]);
      gate.takePending();

      await expect(gate.read(outside)).resolves.toMatchObject({ content: 'hello' });
      await expect(gate.read(stranger)).rejects.toThrow(/not opened from the operating system/);
    });

    it('never reads a vault file or a non-registered extension through the gate', async () => {
      const inside = write('vault/a.md');
      const wrongExt = write('out/c.exe', 'MZ');
      gate.enqueue([inside, wrongExt]);
      gate.takePending();
      await expect(gate.read(inside)).rejects.toThrow();
      await expect(gate.read(wrongExt)).rejects.toThrow();
    });

    it('refuses a file over the size cap', async () => {
      const big = write('out/big.md', 'x'.repeat(200));
      gate.enqueue([big]);
      gate.takePending();
      await expect(gate.read(big)).rejects.toThrow(/larger than/);
    });

    it('writes back only to a path main collected from the OS', async () => {
      const outside = write('out/b.md', 'old');
      const stranger = write('out/other.md', 'keep');
      gate.enqueue([outside]);
      gate.takePending();

      const modifiedMs = await gate.write(outside, 'new content');
      expect(fs.readFileSync(outside, 'utf-8')).toBe('new content');
      expect(modifiedMs).toBe(fs.statSync(outside).mtimeMs);

      await expect(gate.write(stranger, 'tampered')).rejects.toThrow(/not opened from the operating system/);
      expect(fs.readFileSync(stranger, 'utf-8')).toBe('keep');
    });

    it('never writes a vault file or a non-registered extension through the gate', async () => {
      const inside = write('vault/a.md', 'vault');
      const wrongExt = write('out/c.exe', 'MZ');
      gate.enqueue([inside, wrongExt]);
      gate.takePending();
      await expect(gate.write(inside, 'x')).rejects.toThrow();
      await expect(gate.write(wrongExt, 'x')).rejects.toThrow();
      expect(fs.readFileSync(inside, 'utf-8')).toBe('vault');
    });

    it('refuses to write over the size cap, and does not re-create a vanished file', async () => {
      const outside = write('out/b.md', 'old');
      gate.enqueue([outside]);
      gate.takePending();

      await expect(gate.write(outside, 'x'.repeat(200))).rejects.toThrow(/larger than/);
      expect(fs.readFileSync(outside, 'utf-8')).toBe('old');

      fs.rmSync(outside);
      await expect(gate.write(outside, 'back')).rejects.toThrow(/no longer exists/);
      expect(fs.existsSync(outside)).toBe(false);
    });
  });
});
