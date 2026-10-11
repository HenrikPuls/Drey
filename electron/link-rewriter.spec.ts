import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenameLinksRequest } from '../shared/ipc-api';
import { createTempVaults, type TempVaults } from './testing/temp-vaults';

const env = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => env.userData },
  dialog: {},
  shell: {},
  BrowserWindow: { getAllWindows: () => [] },
}));

import { LinkRewriter } from './link-rewriter';
import { VaultManager } from './vault-manager';

let vaults: TempVaults;
let vault: VaultManager;
let rewriter: LinkRewriter;

function request(fromRel: string, toRel: string, extra: Partial<RenameLinksRequest> = {}): RenameLinksRequest {
  return { fromRel, toRel, fromVaultId: 'va', toVaultId: 'va', buffers: [], ...extra };
}

beforeEach(() => {
  vaults = createTempVaults();
  env.userData = vaults.userData;
  vault = new VaultManager();
  rewriter = new LinkRewriter(vault);
});

afterEach(() => {
  vaults.dispose();
});

describe('LinkRewriter.preview', () => {
  it('says what a rename would change and touches nothing', async () => {
    vaults.put(vaults.a, 'Old.md', 'content');
    vaults.put(vaults.a, 'a.md', 'See [[Old]] and [[Old#Part|the part]].');
    vaults.put(vaults.a, 'unrelated.md', 'nothing here');

    const preview = await rewriter.preview(request('Old.md', 'New.md'));

    expect(preview).toEqual({
      files: [
        {
          path: 'a.md',
          newPath: 'a.md',
          links: 2,
          before: 'See [[Old]] and [[Old#Part|the part]].',
          after: 'See [[New]] and [[New#Part|the part]].',
        },
      ],
      assets: [],
    });
    expect(vaults.exists(vaults.a, 'Old.md')).toBe(true);
    expect(vaults.read(vaults.a, 'a.md')).toBe('See [[Old]] and [[Old#Part|the part]].');
  });
});

describe('LinkRewriter.apply', () => {
  it('renames the note and rewrites the notes that link to it', async () => {
    vaults.put(vaults.a, 'Old.md', 'content');
    vaults.put(vaults.a, 'sub/a.md', 'See [[Old]].');
    vaults.put(vaults.a, 'b.md', 'Nothing.');

    const result = await rewriter.apply(request('Old.md', 'New.md'));

    expect(result).toEqual({ path: 'New.md', written: ['sub/a.md'], buffers: [], assets: [], failed: [] });
    expect(vaults.read(vaults.a, 'New.md')).toBe('content');
    expect(vaults.exists(vaults.a, 'Old.md')).toBe(false);
    expect(vaults.read(vaults.a, 'sub/a.md')).toBe('See [[New]].');
    expect(vaults.read(vaults.a, 'b.md')).toBe('Nothing.');
  });

  it('keeps the line endings of a note it rewrites', async () => {
    vaults.put(vaults.a, 'Old.md');
    vaults.put(vaults.a, 'win.md', 'line one\r\n[[Old]]\r\nline three\r\n');

    await rewriter.apply(request('Old.md', 'New.md'));

    expect(vaults.read(vaults.a, 'win.md')).toBe('line one\r\n[[New]]\r\nline three\r\n');
  });

  it('plans against an unsaved buffer and hands the patch back instead of writing', async () => {
    vaults.put(vaults.a, 'Old.md');
    vaults.put(vaults.a, 'open.md', 'saved text without a link');

    const result = await rewriter.apply(
      request('Old.md', 'New.md', { buffers: [{ path: 'open.md', content: 'unsaved: [[Old]]' }] }),
    );

    expect(result.written).toEqual([]);
    expect(result.buffers).toEqual([{ path: 'open.md', content: 'unsaved: [[New]]' }]);
    expect(vaults.read(vaults.a, 'open.md')).toBe('saved text without a link');
  });

  it('reports the moved note under its new path when its own links change', async () => {
    vaults.put(vaults.a, 'a/n.md', '![pic](attachments/x.png)');
    vaults.put(vaults.a, 'a/other.md', '![pic](attachments/x.png)');
    vaults.put(vaults.a, 'a/attachments/x.png', 'png');

    const result = await rewriter.apply(request('a/n.md', 'b/deep/n.md'));

    // The picture is shared, so it stays and the moved note points back at it.
    expect(result.written).toEqual(['b/deep/n.md']);
    expect(result.assets).toEqual([]);
    expect(vaults.read(vaults.a, 'b/deep/n.md')).toBe('![pic](../../a/attachments/x.png)');
    expect(vaults.exists(vaults.a, 'a/attachments/x.png')).toBe(true);
  });

  it('takes along the attachments only the moved note uses and tidies the empty folder', async () => {
    vaults.put(vaults.a, 'a/n.md', '![](attachments/x.png)');
    vaults.put(vaults.a, 'a/attachments/x.png', 'png');

    const result = await rewriter.apply(request('a/n.md', 'b/n.md'));

    expect(result.assets).toEqual([{ kind: 'move', from: 'a/attachments/x.png', to: 'b/attachments/x.png' }]);
    expect(result.failed).toEqual([]);
    expect(vaults.read(vaults.a, 'b/attachments/x.png')).toBe('png');
    expect(vaults.exists(vaults.a, 'a/attachments')).toBe(false);
    expect(vaults.read(vaults.a, 'b/n.md')).toBe('![](attachments/x.png)');
  });

  it('moves a note into another vault: its own attachment moves, a shared one is copied', async () => {
    vaults.put(vaults.a, 'a/n.md', '![](attachments/x.png) ![](attachments/s.png)');
    vaults.put(vaults.a, 'a/other.md', '![](attachments/s.png)');
    vaults.put(vaults.a, 'a/attachments/x.png', 'x');
    vaults.put(vaults.a, 'a/attachments/s.png', 's');
    vaults.put(vaults.b, 'inbox/readme.md');

    const result = await rewriter.apply(request('a/n.md', 'inbox/n.md', { toVaultId: 'vb' }));

    expect(result.path).toBe('inbox/n.md');
    expect(result.failed).toEqual([]);
    expect(result.assets).toEqual([
      { kind: 'move', from: 'a/attachments/x.png', to: 'inbox/attachments/x.png' },
      { kind: 'copy', from: 'a/attachments/s.png', to: 'inbox/attachments/s.png' },
    ]);
    expect(vaults.exists(vaults.b, 'inbox/n.md')).toBe(true);
    expect(vaults.read(vaults.b, 'inbox/attachments/x.png')).toBe('x');
    expect(vaults.read(vaults.b, 'inbox/attachments/s.png')).toBe('s');
    expect(vaults.exists(vaults.a, 'a/n.md')).toBe(false);
    expect(vaults.exists(vaults.a, 'a/attachments/x.png')).toBe(false);
    expect(vaults.read(vaults.a, 'a/attachments/s.png')).toBe('s');
  });

  it('carries on when one note cannot be written, and says which', async () => {
    vaults.put(vaults.a, 'Old.md');
    vaults.put(vaults.a, 'a.md', '[[Old]]');
    vaults.put(vaults.a, 'b.md', '[[Old]]');
    const writeFile = vault.writeFile.bind(vault);
    vi.spyOn(vault, 'writeFile').mockImplementation((rel, ...rest) =>
      rel === 'a.md' ? Promise.reject(new Error('file is locked')) : writeFile(rel, ...rest),
    );

    const result = await rewriter.apply(request('Old.md', 'New.md'));

    expect(result.path).toBe('New.md');
    expect(result.written).toEqual(['b.md']);
    expect(result.failed).toEqual(['a.md: file is locked']);
    expect(vaults.read(vaults.a, 'a.md')).toBe('[[Old]]');
  });

  it('changes no link when the rename itself is refused', async () => {
    vaults.put(vaults.a, 'Old.md');
    vaults.put(vaults.a, 'Taken.md');
    vaults.put(vaults.a, 'a.md', '[[Old]]');

    await expect(rewriter.apply(request('Old.md', 'Taken.md'))).rejects.toThrow('Already exists');
    expect(vaults.read(vaults.a, 'a.md')).toBe('[[Old]]');
  });
});
