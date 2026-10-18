/**
 * The one-time A6 migration (ADR-0010 later change): the actions slice —
 * prompt templates and triggers — moves OUT of `app-config.json` into the
 * assistant plugin's own config file (`<userData>/plugins/assistant/
 * config.json`, key `actions`), because the engine and the settings page
 * that own the data are the assistant plugin's.
 *
 * Idempotent by construction:
 * - the assistant config already holding the key wins (an earlier
 *   migration, or the user's newer edits) — the base copy is ignored;
 * - a base file without the key (first run, or already migrated) is a
 *   no-op.
 *
 * The stale `actions` key is left in `app-config.json` rather than
 * rewriting a file that holds sealed secrets; `normalizeAppConfig` never
 * serves it again, so it is dead data with a documented grave.
 */
import * as fs from 'node:fs';
import { normalizeActionsConfig } from '../../shared/app-config';
import type { PluginConfigStore } from './plugin-config-store';

/** The plugin whose own config receives the actions slice. */
export const ACTIONS_PLUGIN_ID = 'assistant';
/** The key under which the assistant plugin stores it. */
export const ACTIONS_CONFIG_KEY = 'actions';

export async function migrateLegacyActions(
  appConfigPath: string,
  store: Pick<PluginConfigStore, 'get' | 'set'>,
): Promise<void> {
  const existing = await store.get<unknown>(ACTIONS_PLUGIN_ID, ACTIONS_CONFIG_KEY);
  if (existing !== undefined) {
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(appConfigPath, 'utf8'));
  } catch {
    return; // missing or unreadable base config — nothing to migrate
  }
  if (raw === null || typeof raw !== 'object' || !('actions' in raw)) {
    return;
  }
  const normalized = normalizeActionsConfig((raw as Record<string, unknown>)['actions']);
  await store.set(ACTIONS_PLUGIN_ID, ACTIONS_CONFIG_KEY, normalized);
}
