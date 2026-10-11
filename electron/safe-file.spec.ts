import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const renameControl = vi.hoisted(() => ({ failures: 0, code: 'EBUSY' }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    rename: async (from: fs.PathLike, to: fs.PathLike): Promise<void> => {
      if (renameControl.failures > 0) {
        renameControl.failures--;
        throw Object.assign(new Error('locked'), { code: renameControl.code });
      }
      return original.rename(from, to);
    },
  };
});

import { atomicWriteFile, atomicWriteFileSync, readJsonObjectGuarded } from './safe-file';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-safe-file-'));
  renameControl.failures = 0;
  renameControl.code = 'EBUSY';
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('atomicWriteFile', () => {
  it('creates a file and leaves nothing else behind', async () => {
    const file = path.join(dir, 'note.md');
    await atomicWriteFile(file, 'first');
    expect(fs.readFileSync(file, 'utf-8')).toBe('first');
    expect(fs.readdirSync(dir)).toEqual(['note.md']);
  });

  it('replaces an existing file, text and bytes alike', async () => {
    const file = path.join(dir, 'note.md');
    fs.writeFileSync(file, 'old');
    await atomicWriteFile(file, 'Grüße');
    expect(fs.readFileSync(file, 'utf-8')).toBe('Grüße');
    await atomicWriteFile(file, new Uint8Array([1, 2, 3]));
    expect([...fs.readFileSync(file)]).toEqual([1, 2, 3]);
    expect(fs.readdirSync(dir)).toEqual(['note.md']);
  });

  it('retries a rename another program blocked for a moment', async () => {
    const file = path.join(dir, 'note.md');
    fs.writeFileSync(file, 'old');
    renameControl.failures = 2;
    await atomicWriteFile(file, 'new');
    expect(renameControl.failures).toBe(0);
    expect(fs.readFileSync(file, 'utf-8')).toBe('new');
    expect(fs.readdirSync(dir)).toEqual(['note.md']);
  });

  it('falls back to a plain write when the rename keeps failing', async () => {
    const file = path.join(dir, 'note.md');
    fs.writeFileSync(file, 'old');
    renameControl.failures = 99;
    await atomicWriteFile(file, 'new');
    expect(fs.readFileSync(file, 'utf-8')).toBe('new');
    expect(fs.readdirSync(dir)).toEqual(['note.md']);
  });

  it('refuses a read-only file and leaves its content alone', async () => {
    const file = path.join(dir, 'note.md');
    fs.writeFileSync(file, 'old');
    fs.chmodSync(file, 0o444);
    try {
      await expect(atomicWriteFile(file, 'new')).rejects.toThrow();
      expect(fs.readFileSync(file, 'utf-8')).toBe('old');
      expect(fs.readdirSync(dir)).toEqual(['note.md']);
    } finally {
      fs.chmodSync(file, 0o644);
    }
  });
});

describe('atomicWriteFileSync', () => {
  it('creates and replaces a file without leftovers', () => {
    const file = path.join(dir, 'app-config.json');
    atomicWriteFileSync(file, '{"a":1}');
    atomicWriteFileSync(file, '{"a":2}');
    expect(fs.readFileSync(file, 'utf-8')).toBe('{"a":2}');
    expect(fs.readdirSync(dir)).toEqual(['app-config.json']);
  });
});

describe('readJsonObjectGuarded', () => {
  const now = new Date(2026, 9, 11, 8, 5, 9);

  it('reports a missing file as the first run', () => {
    expect(readJsonObjectGuarded(path.join(dir, 'app-config.json'))).toEqual({ kind: 'missing' });
  });

  it('reads an object, with or without a byte-order mark', () => {
    const file = path.join(dir, 'app-config.json');
    fs.writeFileSync(file, '﻿{"llm":{"model":"x"}}');
    expect(readJsonObjectGuarded(file)).toEqual({ kind: 'ok', value: { llm: { model: 'x' } } });
    expect(fs.readdirSync(dir)).toEqual(['app-config.json']);
  });

  it.each([
    ['an empty file', ''],
    ['a cut-off file', '{"llm":{"apiKey":"sk-'],
    ['an array', '[1,2]'],
  ])('sets %s aside instead of leaving it to be overwritten', (_label, content) => {
    const file = path.join(dir, 'app-config.json');
    fs.writeFileSync(file, content);
    const result = readJsonObjectGuarded(file, now);
    const backupPath = `${file}.corrupt-20261011-080509`;
    expect(result).toMatchObject({ kind: 'unreadable', problem: { filePath: file, backupPath } });
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(backupPath, 'utf-8')).toBe(content);
  });
});
