import { describe, expect, it } from 'vitest';
import { fleetSettingDefault } from './fleet-defaults';

describe('fleetSettingDefault', () => {
  it('answers the table and the per-runner keys that fall back to it', () => {
    expect(fleetSettingDefault('fleet.contextCapTokens')).toBe(160_000);
    expect(fleetSettingDefault('fleet.compactAboveTokens.opencode')).toBe(60_000);
    expect(fleetSettingDefault('fleet.pool.claude-code.size')).toBe(1);
    expect(fleetSettingDefault('gitPath')).toBe('git');
  });

  it('knows nothing of a key without a default', () => {
    expect(fleetSettingDefault('remote.port')).toBeNull();
  });
});
