import { describe, expect, it } from 'vitest';
import { DEFAULT_PROMPTS } from './default-prompts';

describe('DEFAULT_PROMPTS', () => {
  it('ships a prompt for every agent column of the default pipeline', () => {
    expect(Object.keys(DEFAULT_PROMPTS)).toEqual(['plan-default', 'build-default', 'review-default']);
  });

  it('keeps backticks and ends each prompt with a newline', () => {
    for (const text of Object.values(DEFAULT_PROMPTS)) {
      expect(text.endsWith('\n')).toBe(true);
    }
    expect(DEFAULT_PROMPTS['plan-default']).toContain('`## Plan`');
    for (const text of Object.values(DEFAULT_PROMPTS)) {
      expect(text).toContain('How to work:');
    }
  });
});
