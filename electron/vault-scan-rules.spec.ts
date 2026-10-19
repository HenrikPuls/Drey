import { describe, expect, it } from 'vitest';
import { isReservedRootName, vaultScanIgnore } from './vault-scan-rules';

/**
 * The vault's reserved-root rule (T-0044, ADR-0080): `_`-prefixed
 * folders at the vault root only are machine state (the fleet's
 * `_worktrees/` base) — invisible to the file tree, the md index and
 * the watcher, while `tickets/_meta` (not at the root) stays visible.
 */

describe('isReservedRootName', () => {
  it('reserves the _-prefix, nothing else', () => {
    expect(isReservedRootName('_worktrees')).toBe(true);
    expect(isReservedRootName('_meta')).toBe(true);
    expect(isReservedRootName('tickets')).toBe(false);
    expect(isReservedRootName('daily')).toBe(false);
    expect(isReservedRootName('T-0044')).toBe(false);
  });
});

describe('vaultScanIgnore', () => {
  const root = '/vault/root';
  const ignored = vaultScanIgnore(root);

  it('ignores reserved root folders and everything under them', () => {
    expect(ignored(`${root}/_worktrees`)).toBe(true);
    expect(ignored(`${root}/_worktrees/T-0044`)).toBe(true);
    expect(ignored(`${root}/_worktrees/T-0044/plugins/tickets/main/index.ts`)).toBe(true);
  });

  it('keeps ordinary folders, files and the root itself', () => {
    expect(ignored(root)).toBe(false);
    expect(ignored(`${root}/tickets/T-0001.md`)).toBe(false);
    expect(ignored(`${root}/daily/2026/note.md`)).toBe(false);
  });

  it('a _-folder below the root is NOT reserved -- tickets/_meta stays watched', () => {
    expect(ignored(`${root}/tickets/_meta/pipeline.md`)).toBe(false);
    expect(ignored(`${root}/tickets/_meta/prompts/build-default.md`)).toBe(false);
    expect(ignored(`${root}/deep/nested/_other/file.md`)).toBe(false);
  });

  it('still ignores dot entries anywhere (the pre-existing rule)', () => {
    expect(ignored(`${root}/.git/config`)).toBe(true);
    expect(ignored(`${root}/.drafts/draft.md`)).toBe(true);
    expect(ignored(`${root}/notes/.hidden.md`)).toBe(true);
    expect(ignored(`${root}/notes/note.md.chat.json`)).toBe(false); // not dot-prefixed
  });

  it('paths outside the vault are not ours to judge', () => {
    expect(ignored('/elsewhere/_worktrees/T-0044')).toBe(false);
    expect(ignored('/elsewhere/.git')).toBe(true); // dot entries anywhere
  });

  it('folds case and slash direction on win32, exact elsewhere', () => {
    const mixed = `${root.replaceAll('/', '\\')}\\_WORKTREES\\T-0044`;
    expect(vaultScanIgnore('/vault/Root')(mixed)).toBe(process.platform === 'win32');
    expect(vaultScanIgnore(root)(`${root}\\_worktrees\\T-0044`)).toBe(true);
  });
});
