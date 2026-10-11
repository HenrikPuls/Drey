import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretCipher } from './config-secrets';

let userDataDir = '';

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {},
}));

import { AppConfigStore } from './app-config';

function fakeCipher(available = true): SecretCipher {
  return {
    isAvailable: () => available,
    encrypt: (plain) => Buffer.from(`sealed:${plain}`, 'utf8'),
    decrypt: (sealed) => {
      const text = Buffer.from(sealed).toString('utf8');
      if (!text.startsWith('sealed:')) {
        throw new Error('not ours');
      }
      return text.slice('sealed:'.length);
    },
  };
}

const configFile = (): string => path.join(userDataDir, 'app-config.json');
const readFile = (): string => fs.readFileSync(configFile(), 'utf8');

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-config-'));
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('AppConfigStore secrets', () => {
  it('writes the key sealed and hands it out plain', () => {
    const store = new AppConfigStore(fakeCipher());
    const saved = store.set({ ...store.get(), llm: { ...store.get().llm, apiKey: 'sk-123' } });

    expect(saved.llm.apiKey).toBe('sk-123');
    expect(readFile()).not.toContain('sk-123"');
    expect(JSON.parse(readFile()).llm.apiKey).toMatch(/^enc:v1:/);
    expect(new AppConfigStore(fakeCipher()).get().llm.apiKey).toBe('sk-123');
  });

  it('seals a plain key found in the file at startup', () => {
    fs.writeFileSync(configFile(), JSON.stringify({ llm: { apiKey: 'sk-old' } }));

    const store = new AppConfigStore(fakeCipher());

    expect(store.get().llm.apiKey).toBe('sk-old');
    expect(store.lostSecrets).toBeNull();
    expect(JSON.parse(readFile()).llm.apiKey).toMatch(/^enc:v1:/);
  });

  it('does not write at startup when the file holds no plain secret', () => {
    fs.writeFileSync(configFile(), '{"llm":{"model":"m"}}');
    new AppConfigStore(fakeCipher());
    expect(readFile()).toBe('{"llm":{"model":"m"}}');
  });

  it('keeps plain values when the OS offers no protection', () => {
    fs.writeFileSync(configFile(), JSON.stringify({ llm: { apiKey: 'sk-old' } }));
    const store = new AppConfigStore(fakeCipher(false));
    store.set(store.get());
    expect(JSON.parse(readFile()).llm.apiKey).toBe('sk-old');
  });

  it('reports a key it cannot open and keeps a copy of the file', () => {
    const foreign = `enc:v1:${Buffer.from('another machine').toString('base64')}`;
    fs.writeFileSync(configFile(), JSON.stringify({ llm: { apiKey: foreign, model: 'm' } }));

    const store = new AppConfigStore(fakeCipher());

    expect(store.get().llm.apiKey).toBeNull();
    expect(store.get().llm.model).toBe('m');
    expect(store.lostSecrets?.labels).toEqual(['LLM API key']);
    const backupPath = store.lostSecrets?.backupPath ?? '';
    expect(path.basename(backupPath)).toMatch(/^app-config\.json\.undecryptable-\d{8}-\d{6}$/);
    expect(fs.readFileSync(backupPath, 'utf8')).toContain(foreign);

    // The value is safe in the copy, so the file drops it: no second report.
    expect(readFile()).not.toContain(foreign);
    expect(new AppConfigStore(fakeCipher()).lostSecrets).toBeNull();
  });
});
