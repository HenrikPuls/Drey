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
 * class only does fs and holds the in-memory copy. Writes are atomic and an
 * unusable file is set aside rather than overwritten (`safe-file.ts`).
 */
import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppConfig, DEFAULT_APP_CONFIG, normalizeAppConfig } from '../shared/app-config';
import { atomicWriteFileSync, readJsonObjectGuarded, type UnreadableFile } from './safe-file';

const configFilePath = (): string => path.join(app.getPath('userData'), 'app-config.json');

export class AppConfigStore {
  private config: AppConfig;
  private readonly changeCallbacks: Array<(config: AppConfig) => void> = [];

  /**
   * Set when `app-config.json` existed but could not be used: the app runs
   * on defaults and the file was set aside. Main tells the user once.
   */
  readonly loadProblem: UnreadableFile | null;

  constructor() {
    const stored = readJsonObjectGuarded(configFilePath());
    this.loadProblem = stored.kind === 'unreadable' ? stored.problem : null;
    // First run or an unusable file -- defaults.
    this.config = normalizeAppConfig(stored.kind === 'ok' ? stored.value : DEFAULT_APP_CONFIG);
  }

  /** The current, always-complete config. */
  get(): AppConfig {
    return this.config;
  }

  /**
   * Observes every successful write (currently `config:set` and
   * `spell:add-word`); the callback receives the stored config. One wiring
   * site instead of one per writer. Returns an unsubscribe.
   */
  onChange(cb: (config: AppConfig) => void): () => void {
    this.changeCallbacks.push(cb);
    return () => {
      const i = this.changeCallbacks.indexOf(cb);
      if (i >= 0) {
        this.changeCallbacks.splice(i, 1);
      }
    };
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
    for (const cb of [...this.changeCallbacks]) {
      try {
        cb(this.config);
      } catch {
        // An observer must never break the write that notified it.
      }
    }
    return this.config;
  }

  private writeToDisk(): void {
    const filePath = configFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteFileSync(filePath, JSON.stringify(this.config, null, 2));
  }
}
