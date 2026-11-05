import { describe, expect, it } from 'vitest';
import { hasKimiProvider, parseKimiModels, probeKimi } from './kimi-probe';

const TOML = [
  'default_model = "zai-coding-plan/glm-5.3-flash"',
  '[models."kimi-code/k3"]',
  'provider = "managed:kimi-code"',
  '[models."zai-coding-plan/glm-5.3"]',
  '[models."kimi-code/k3"]',
].join('\n');

const LIST = 'managed:kimi-code  type=kimi  models=6  source=oauth\nzai-coding-plan  type=openai  models=3  source=inline\n\nDefault model: x\n';

describe('kimi probe', () => {
  it('reads the model aliases off the config headers, once each', () => {
    expect(parseKimiModels(TOML)).toEqual(['kimi-code/k3', 'zai-coding-plan/glm-5.3']);
  });

  it('counts a provider with models as configured', () => {
    expect(hasKimiProvider(LIST)).toBe(true);
    expect(hasKimiProvider('')).toBe(false);
    expect(hasKimiProvider('p  type=kimi  models=0')).toBe(false);
  });

  it('is ready when installed with a provider', async () => {
    const probe = await probeKimi({
      exec: async (_cmd, args) => (args[0] === '--version' ? '2.4.1\n' : LIST),
      readConfig: async () => TOML,
    });
    expect(probe).toEqual({ installed: true, version: '2.4.1', configured: true, models: ['kimi-code/k3', 'zai-coding-plan/glm-5.3'], note: null });
  });

  it('asks for kimi login when installed without a provider', async () => {
    const probe = await probeKimi({ exec: async (_c, args) => (args[0] === '--version' ? '2.4.1' : ''), readConfig: async () => null });
    expect(probe.installed).toBe(true);
    expect(probe.configured).toBe(false);
    expect(probe.note).toMatch(/kimi login/);
  });

  it('reports a missing CLI without throwing', async () => {
    const probe = await probeKimi({ exec: () => Promise.reject(new Error('ENOENT')), readConfig: async () => null });
    expect(probe).toMatchObject({ installed: false, version: null, configured: false });
    expect(probe.note).toMatch(/not installed/);
  });
});
