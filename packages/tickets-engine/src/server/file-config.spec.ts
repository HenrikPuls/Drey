import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileConfigStore } from './file-config';

let root: string;
let file: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(tmpdir(), 'file-config-'));
  file = path.join(root, 'home', 'config.json');
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

const onDisk = async (): Promise<Record<string, unknown>> => JSON.parse(await fsp.readFile(file, 'utf8')) as Record<string, unknown>;

describe('FileConfigStore.setMany', () => {
  it('writes every key and keeps the ones it was not given (the engine token, paired devices)', async () => {
    await new FileConfigStore(file).set('engine.token', 'keep-me');
    await new FileConfigStore(file).setMany([['backend', 'dricket'], ['dk.store', 'E:/new']]);
    expect(await onDisk()).toEqual({ 'engine.token': 'keep-me', backend: 'dricket', 'dk.store': 'E:/new' });
  });

  it('replaces an old value, and a later store over the same file reads the new one', async () => {
    await new FileConfigStore(file).setMany([['dk.store', 'E:/old']]);
    await new FileConfigStore(file).setMany([['dk.store', 'E:/new']]);
    expect(await new FileConfigStore(file).get('dk.store')).toBe('E:/new');
  });

  it('creates the engine home when it does not exist yet (a first start)', async () => {
    await new FileConfigStore(file).setMany([['backend', 'shadow']]);
    expect((await onDisk())['backend']).toBe('shadow');
  });
});
