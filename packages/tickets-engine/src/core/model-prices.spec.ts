import { describe, expect, it } from 'vitest';
import { MODEL_PRICES, costOf, priceKeyOf } from './model-prices';

describe('priceKeyOf', () => {
  it('strips the provider prefix and lowercases', () => {
    expect(priceKeyOf('zai-coding-plan/glm-5.3')).toBe('glm-5.3');
    expect(priceKeyOf('Opus')).toBe('opus');
    expect(priceKeyOf('opus')).toBe('opus');
  });

  it('refuses nothing-shaped input', () => {
    expect(priceKeyOf(null)).toBeNull();
    expect(priceKeyOf('')).toBeNull();
    expect(priceKeyOf('  ')).toBeNull();
  });
});

describe('costOf', () => {
  it('prices the known models from in/out tokens', () => {
    // 48k opus in + 6k out: 0.048 * 15 + 0.006 * 75 = 1.17
    expect(costOf('opus', 48_000, 6_000)).toBe(1.17);
    // sonnet at 48k in / 6k out: 0.048 * 3 + 0.006 * 15 = 0.234
    expect(costOf('sonnet', 48_000, 6_000)).toBe(0.234);
    expect(costOf('haiku', 1_000_000, 1_000_000)).toBe(6);
    expect(costOf('glm-5.2', 1_000_000, 0)).toBe(0.6);
    expect(costOf('kimi-k2', 0, 2_000_000)).toBe(5);
    expect(costOf('glm-5.3-flash', 1_000_000, 1_000_000)).toBe(1);
  });

  it('prices through a provider prefix', () => {
    expect(costOf('zai-coding-plan/glm-5.3', 1_000_000, 0)).toBe(1);
    expect(costOf('anthropic/claude-opus-4-1', 1, 1)).toBeNull(); // exact ids are not in the table
  });

  it('stays null for unknown models and unreported usage — never a 0 fake', () => {
    expect(costOf('mystery-model', 48_000, 6_000)).toBeNull();
    expect(costOf(null, 48_000, 6_000)).toBeNull();
    expect(costOf('opus', 0, 0)).toBeNull();
  });

  it('rounds to the ledger four digits', () => {
    // 331_122 opus in + 1_511 out → 4.96683 + 0.113325 = 5.080155 → 5.0802
    expect(costOf('opus', 331_122, 1_511)).toBe(5.0802);
  });

  it('covers every model the repo pins', () => {
    for (const model of ['opus', 'sonnet', 'haiku', 'glm-5.2', 'glm-5.3', 'glm-5.3-flash', 'kimi-k2']) {
      expect(MODEL_PRICES[model]).toBeDefined();
      expect(costOf(model, 1_000_000, 1_000_000)).not.toBeNull();
    }
  });
});
