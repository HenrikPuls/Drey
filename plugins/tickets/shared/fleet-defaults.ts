/**
 * The default of every fleet setting that has one — the single table the
 * runtime (`main/fleet/protocol.ts` derives its DEFAULT_* from it) and
 * Settings → Tickets read, so a field left empty shows exactly the value
 * the runner will use and the two cannot drift apart.
 */
export const FLEET_SETTING_DEFAULTS = {
  defaultWorker: 'opencode',
  gitPath: 'git',
  'fleet.compactAboveTokens': 60_000,
  'fleet.resumePauseTtlMin': 15,
  'fleet.contextCapTokens': 160_000,
  'fleet.cap.gateFailureLines': 40,
  'fleet.cap.gateFailureBytes': 4096,
  'fleet.cap.diffStatLines': 50,
  'fleet.cap.diffStatBytes': 4096,
  'fleet.pool.size': 1,
} as const;

export type FleetSettingKey = keyof typeof FLEET_SETTING_DEFAULTS;

/** The default of a setting key, or null when it has none (`fleet.pool.<p>.size` shares `fleet.pool.size`). */
export function fleetSettingDefault(key: string): string | number | null {
  if (key in FLEET_SETTING_DEFAULTS) {
    return FLEET_SETTING_DEFAULTS[key as FleetSettingKey];
  }
  if (/^fleet\.pool\.[^.]+\.size$/.test(key)) {
    return FLEET_SETTING_DEFAULTS['fleet.pool.size'];
  }
  if (/^fleet\.compactAboveTokens\./.test(key)) {
    return FLEET_SETTING_DEFAULTS['fleet.compactAboveTokens'];
  }
  return null;
}
