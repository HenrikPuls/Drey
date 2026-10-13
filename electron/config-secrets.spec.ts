import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_CONFIG, normalizeAppConfig, type AppConfig } from '../shared/app-config';
import { isSealed, openConfigSecrets, sealConfigSecrets, type SecretCipher } from './config-secrets';

/** Reversible stand-in for the OS cipher: reverses the bytes behind a marker. */
function fakeCipher(available = true): SecretCipher {
  return {
    isAvailable: () => available,
    encrypt: (plain) => Buffer.from(`sealed:${[...plain].reverse().join('')}`, 'utf8'),
    decrypt: (sealed) => {
      const text = Buffer.from(sealed).toString('utf8');
      if (!text.startsWith('sealed:')) {
        throw new Error('not ours');
      }
      return [...text.slice('sealed:'.length)].reverse().join('');
    },
  };
}

function configWithSecrets(): AppConfig {
  return normalizeAppConfig({
    ...DEFAULT_APP_CONFIG,
    llm: { ...DEFAULT_APP_CONFIG.llm, apiKey: 'sk-cloud-123', model: 'some-model' },
    tools: {
      ...DEFAULT_APP_CONFIG.tools,
      webSearch: { ...DEFAULT_APP_CONFIG.tools.webSearch, provider: 'brave', apiKey: 'bsa-9' },
      servers: [
        {
          id: 'files',
          name: 'Files',
          enabled: true,
          approval: 'ask',
          transport: { kind: 'stdio', command: 'node', args: ['x.js'], env: { TOKEN: 't-1', EMPTY: '' } },
        },
        {
          id: 'web',
          name: 'Web',
          enabled: true,
          approval: 'ask',
          transport: { kind: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer b-2' } },
        },
      ],
    },
  });
}

describe('sealConfigSecrets', () => {
  it('seals the API key and the MCP env and header values, nothing else', () => {
    const plain = configWithSecrets();
    const sealed = sealConfigSecrets(plain, fakeCipher());
    const text = JSON.stringify(sealed);

    expect(text).not.toContain('sk-cloud-123');
    expect(text).not.toContain('t-1');
    expect(text).not.toContain('bsa-9');
    expect(sealed.tools.webSearch.provider).toBe('brave');
    expect(text).not.toContain('Bearer b-2');
    expect(isSealed(sealed.llm.apiKey ?? '')).toBe(true);

    // Names, URLs, commands and the model stay readable.
    expect(sealed.llm.model).toBe('some-model');
    expect(sealed.llm.baseUrl).toBe(plain.llm.baseUrl);
    const [files, web] = sealed.tools.servers;
    expect(files.transport).toMatchObject({ command: 'node', args: ['x.js'] });
    expect(web.transport).toMatchObject({ url: 'https://example.test/mcp' });
    expect(Object.keys(files.transport.kind === 'stdio' ? files.transport.env : {})).toEqual([
      'TOKEN',
      'EMPTY',
    ]);
  });

  it('leaves an empty value and a missing key alone', () => {
    const sealed = sealConfigSecrets(
      normalizeAppConfig({ ...configWithSecrets(), llm: { ...DEFAULT_APP_CONFIG.llm, apiKey: null } }),
      fakeCipher(),
    );
    expect(sealed.llm.apiKey).toBeNull();
    const files = sealed.tools.servers[0];
    expect(files.transport.kind === 'stdio' ? files.transport.env['EMPTY'] : null).toBe('');
  });

  it('does not change the config it was given', () => {
    const plain = configWithSecrets();
    const before = JSON.stringify(plain);
    sealConfigSecrets(plain, fakeCipher());
    expect(JSON.stringify(plain)).toBe(before);
  });

  it('writes plain values when the OS offers no protection', () => {
    const plain = configWithSecrets();
    expect(sealConfigSecrets(plain, fakeCipher(false))).toEqual(plain);
  });
});

describe('openConfigSecrets', () => {
  it('returns what was sealed', () => {
    const plain = configWithSecrets();
    const opened = openConfigSecrets(sealConfigSecrets(plain, fakeCipher()), fakeCipher());
    expect(opened.config).toEqual(plain);
    expect(opened.lost).toEqual([]);
    expect(opened.hadPlainSecrets).toBe(false);
  });

  it('survives the trip through the file and the normaliser', () => {
    const plain = configWithSecrets();
    const onDisk = JSON.stringify(sealConfigSecrets(plain, fakeCipher()), null, 2);
    const opened = openConfigSecrets(normalizeAppConfig(JSON.parse(onDisk)), fakeCipher());
    expect(opened.config).toEqual(plain);
  });

  it('reads plain values and says the file held some', () => {
    const plain = configWithSecrets();
    const opened = openConfigSecrets(plain, fakeCipher());
    expect(opened.config).toEqual(plain);
    expect(opened.hadPlainSecrets).toBe(true);
  });

  it('reports no plain secrets for a config that has none', () => {
    const opened = openConfigSecrets(normalizeAppConfig(DEFAULT_APP_CONFIG), fakeCipher());
    expect(opened.hadPlainSecrets).toBe(false);
    expect(opened.lost).toEqual([]);
  });

  it('empties and names a value that cannot be opened, keeping the rest', () => {
    const sealed = sealConfigSecrets(configWithSecrets(), fakeCipher());
    const foreign = normalizeAppConfig({
      ...sealed,
      llm: { ...sealed.llm, apiKey: `enc:v1:${Buffer.from('from another machine').toString('base64')}` },
    });
    const opened = openConfigSecrets(foreign, fakeCipher());

    expect(opened.config.llm.apiKey).toBeNull();
    expect(opened.lost).toEqual(['LLM API key']);
    const files = opened.config.tools.servers[0];
    expect(files.transport.kind === 'stdio' ? files.transport.env['TOKEN'] : null).toBe('t-1');
  });

  it('names every sealed value as lost when the OS store is unavailable', () => {
    const sealed = sealConfigSecrets(configWithSecrets(), fakeCipher());
    const opened = openConfigSecrets(sealed, fakeCipher(false));
    expect(opened.lost).toEqual([
      'LLM API key',
      'Web search API key',
      'MCP server "Files": environment variable TOKEN',
      'MCP server "Web": header Authorization',
    ]);
    expect(opened.config.llm.apiKey).toBeNull();
  });
});
