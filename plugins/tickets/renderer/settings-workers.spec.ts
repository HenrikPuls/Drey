import { describe, expect, it } from 'vitest';
import { WORKER_PROVIDERS } from '../main/fleet/protocol';
import { RUNNER_FIELDS, RUNNER_LABEL } from './settings-workers';

const keysOf = (provider: keyof typeof RUNNER_FIELDS): string[] => RUNNER_FIELDS[provider].map((f) => f.key);

describe('RUNNER_FIELDS (req-71)', () => {
  it('has a section and a label for every worker provider', () => {
    expect(Object.keys(RUNNER_FIELDS).sort()).toEqual([...WORKER_PROVIDERS].sort());
    expect(Object.keys(RUNNER_LABEL).sort()).toEqual([...WORKER_PROVIDERS].sort());
  });

  it('writes the pool and compact-override keys the main side reads per provider', () => {
    for (const provider of WORKER_PROVIDERS) {
      expect(keysOf(provider)).toContain(`fleet.pool.${provider}.size`);
      expect(keysOf(provider)).toContain(`fleet.compactAboveTokens.${provider}`);
    }
  });

  it('offers the pool probe only for OpenCode', () => {
    expect(keysOf('opencode')).toContain('fleet.pool.opencode.probe');
    expect(keysOf('claude-code').some((k) => k.endsWith('.probe'))).toBe(false);
  });

  it('offers the dispatched-run permissions only for Claude Code, on the existing key', () => {
    expect(keysOf('claude-code')).toContain('autoPermissionMode');
    expect(keysOf('opencode')).not.toContain('autoPermissionMode');
    const field = RUNNER_FIELDS['claude-code'].find((f) => f.key === 'autoPermissionMode');
    expect(field?.choices?.map(([value]) => value)).toEqual(['accept-edits', 'bypass']);
    expect(field?.fallback).toBe('accept-edits');
  });

  it('keeps control ids unique across both runners', () => {
    const ids = WORKER_PROVIDERS.flatMap((p) => RUNNER_FIELDS[p].map((f) => f.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
