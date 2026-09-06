/**
 * Reads and persists the app-level configuration (`shared/app-config.ts`):
 * the LLM connection, action templates/triggers, confirmation prefs.
 *
 * One JSON file, `app-config.json`, under `app.getPath('userData')` --
 * exactly the pattern `electron/vault-manager.ts` (`vault-config.json`)
 * already uses. It is
 * deliberately NOT in the vault: settings are application config, not note
 * data, and must not depend on which vault is open
 * (`docs/09_architecture_decisions/0010-app-settings-storage.md`).
 *
 * All shape/normalisation logic is the pure `normalizeAppConfig`; this
 * class only does fs and holds the in-memory copy.
 */
import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppConfig, DEFAULT_APP_CONFIG, normalizeAppConfig } from '../shared/app-config';

const configFilePath = (): string => path.join(app.getPath('userData'), 'app-config.json');

export class AppConfigStore {
  private config: AppConfig;

  constructor() {
    this.config = this.readFromDisk();
  }

  /** The current, always-complete config. */
  get(): AppConfig {
    return this.config;
  }

  /**
   * Replaces the whole config with `next` (the Settings screen is the only
   * editor and always holds the full object), normalises it, persists, and
   * returns the stored result so the renderer adopts exactly what landed on
   * disk.
   */
  set(next: unknown): AppConfig {
    this.config = normalizeAppConfig(next);
    this.writeToDisk();
    return this.config;
  }

  private readFromDisk(): AppConfig {
    try {
      const raw = fs.readFileSync(configFilePath(), 'utf-8');
      return normalizeAppConfig(JSON.parse(raw));
    } catch {
      // First run or an unreadable/corrupt file -- defaults, same fallback
      // stance as VaultManager's readConfig.
      return normalizeAppConfig(DEFAULT_APP_CONFIG);
    }
  }

  private writeToDisk(): void {
    const filePath = configFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(this.config, null, 2), 'utf-8');
  }
}
