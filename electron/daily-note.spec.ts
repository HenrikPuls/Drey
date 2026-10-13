import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfigStore } from './app-config';
import { createTempVaults, type TempVaults } from './testing/temp-vaults';

const env = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => env.userData },
  dialog: {},
  shell: {},
  safeStorage: {},
  BrowserWindow: { getAllWindows: () => [] },
}));

import { DailyNoteManager } from './daily-note';
import { OwnWriteLedger } from './own-write-ledger';
import { VaultManager } from './vault-manager';

let vaults: TempVaults;
let vault: VaultManager;

function manager(dir = 'daily'): DailyNoteManager {
  const config = { get: () => ({ daily: { dir } }) } as unknown as AppConfigStore;
  return new DailyNoteManager(vault, config);
}

/** 5 September 2026, 14:32:07 local time. */
const NOW = new Date(2026, 8, 5, 14, 32, 7);

beforeEach(() => {
  vaults = createTempVaults();
  env.userData = vaults.userData;
  vault = new VaultManager();
});

afterEach(() => {
  vi.useRealTimers();
  vaults.dispose();
});

describe('DailyNoteManager.ensureTodayNote', () => {
  it('creates the note under year and month, from a starter template it leaves for editing', async () => {
    const relPath = await manager().ensureTodayNote(NOW);

    expect(relPath).toBe('daily/2026/09/2026-09-05.md');
    expect(vaults.read(vaults.a, relPath)).toBe(
      '---\ntitle: "2026-09-05"\ncreated: "2026-09-05T14:32:07"\nupdated: "2026-09-05T14:32:07"\n---\n\n# 2026-09-05\n\n## 14:32\n',
    );
    // The template keeps its placeholders -- it is the user's to edit.
    expect(vaults.read(vaults.a, 'templates/daily.md')).toContain('# {{date}}');
  });

  it('uses the template of the vault and the configured folder', async () => {
    vaults.put(vaults.a, 'templates/daily.md', 'Journal {{title}} at {{time}}\n');

    const relPath = await manager('journal/days').ensureTodayNote(NOW);

    expect(relPath).toBe('journal/days/2026/09/2026-09-05.md');
    expect(vaults.read(vaults.a, relPath)).toBe('Journal 2026-09-05 at 14:32\n');
    expect(vaults.read(vaults.a, 'templates/daily.md')).toBe('Journal {{title}} at {{time}}\n');
  });

  it('writes through the vault manager and reports what it created', async () => {
    const ledger = new OwnWriteLedger();
    vault = new VaultManager(ledger);
    const created: Array<{ vaultId: string; paths: readonly string[] }> = [];
    const config = { get: () => ({ daily: { dir: 'daily' } }) } as unknown as AppConfigStore;
    const notes = new DailyNoteManager(vault, config, (vaultId, paths) =>
      created.push({ vaultId, paths }),
    );

    const relPath = await notes.ensureTodayNote(NOW);

    expect(created).toEqual([{ vaultId: 'va', paths: ['templates/daily.md', relPath] }]);
    // Both writes are in the own-write ledger: the watcher drops their echo.
    for (const rel of ['templates/daily.md', relPath]) {
      const mtimeMs = fs.statSync(path.join(vaults.a, rel)).mtimeMs;
      expect(ledger.isOwnEvent('va', rel, 'add', mtimeMs)).toBe(true);
    }

    // The note exists now: nothing is written, nothing reported.
    await notes.ensureTodayNote(NOW);
    expect(created).toHaveLength(1);
  });

  it('returns the existing note untouched', async () => {
    vaults.put(vaults.a, 'daily/2026/09/2026-09-05.md', 'what I wrote this morning');

    await expect(manager().ensureTodayNote(NOW)).resolves.toBe('daily/2026/09/2026-09-05.md');

    expect(vaults.read(vaults.a, 'daily/2026/09/2026-09-05.md')).toBe('what I wrote this morning');
    expect(vaults.exists(vaults.a, 'templates')).toBe(false);
  });

  it('writes into the active vault only', async () => {
    vault.setActiveVault('vb');
    await manager().ensureTodayNote(NOW);
    expect(vaults.exists(vaults.b, 'daily/2026/09/2026-09-05.md')).toBe(true);
    expect(vaults.exists(vaults.a, 'daily')).toBe(false);
  });

  it('refuses without an active vault, or when its folder is gone', async () => {
    fs.rmSync(vaults.a, { recursive: true });
    await expect(manager().ensureTodayNote(NOW)).rejects.toThrow('No vault is active');

    vault.removeVault('va');
    vault.removeVault('vb');
    await expect(manager().ensureTodayNote(NOW)).rejects.toThrow('No vault is active');
  });
});

describe('DailyNoteManager.noteContentFor', () => {
  it('previews a note for another day without writing anything', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const content = await manager().noteContentFor('2026-01-31');

    // The day is the one asked for, the time is now.
    expect(content).toContain('title: "2026-01-31"');
    expect(content).toContain('created: "2026-01-31T14:32:07"');
    expect(content).toContain('## 14:32');
    expect(vaults.exists(vaults.a, 'templates')).toBe(false);
    expect(vaults.exists(vaults.a, 'daily')).toBe(false);
  });

  it('uses the template of the vault', async () => {
    vaults.put(vaults.a, 'templates/daily.md', 'Day {{date}}');
    await expect(manager().noteContentFor('2026-02-01')).resolves.toBe('Day 2026-02-01');
  });

  it('refuses something that is not a date', async () => {
    await expect(manager().noteContentFor('5.9.2026')).rejects.toThrow('Not a YYYY-MM-DD date');
    await expect(manager().noteContentFor('2026-9-5')).rejects.toThrow('Not a YYYY-MM-DD date');
  });
});
