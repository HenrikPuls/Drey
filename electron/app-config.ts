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
 *
 * Secrets (API key, MCP server env and header values) are encrypted on
 * disk with the OS user's key and plain in memory (`config-secrets.ts`).
 */
import { app, safeStorage } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppConfig, DEFAULT_APP_CONFIG, normalizeAppConfig } from '../shared/app-config';
import { openConfigSecrets, sealConfigSecrets, type SecretCipher } from './config-secrets';
import {
  atomicWriteFileSync,
  keepCopy,
  readJsonObjectGuarded,
  type UnreadableFile,
} from './safe-file';

const configFilePath = (): string => path.join(app.getPath('userData'), 'app-config.json');

/**
 * `safeStorage` as the secrets cipher. On Linux without a secret service
 * Electron falls back to a fixed password (`basic_text`), which protects
 * nothing -- that counts as unavailable, so values stay plain rather than
 * looking protected.
 */
const osCipher: SecretCipher = {
  isAvailable: () =>
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (sealed) => safeStorage.decryptString(Buffer.from(sealed)),
};

/** Sealed secrets of `app-config.json` that could not be opened at startup. */
export interface LostSecrets {
  /** What was lost, in the user's terms (`LLM API key`, ...). */
  labels: string[];
  /** A copy of the file as it was, still holding the sealed values. */
  backupPath: string | null;
}

export class AppConfigStore {
  private config: AppConfig;
  private readonly changeCallbacks: Array<(config: AppConfig) => void> = [];

  /**
   * Set when `app-config.json` existed but could not be used: the app runs
   * on defaults and the file was set aside. Main tells the user once.
   */
  readonly loadProblem: UnreadableFile | null;

  /**
   * Set when the file held encrypted secrets this OS user cannot open
   * (the file was copied from another machine or account, or the OS store
   * is not reachable). Those fields are empty; main tells the user once.
   */
  readonly lostSecrets: LostSecrets | null;

  /** Must be created after `app` is ready -- `safeStorage` needs that. */
  constructor(private readonly cipher: SecretCipher = osCipher) {
    const filePath = configFilePath();
    const stored = readJsonObjectGuarded(filePath);
    this.loadProblem = stored.kind === 'unreadable' ? stored.problem : null;
    // First run or an unusable file -- defaults.
    const opened = openConfigSecrets(
      normalizeAppConfig(stored.kind === 'ok' ? stored.value : DEFAULT_APP_CONFIG),
      this.cipher,
    );
    this.config = opened.config;
    // The next write drops what could not be opened, so keep the file.
    this.lostSecrets =
      opened.lost.length > 0
        ? { labels: opened.lost, backupPath: keepCopy(filePath, 'undecryptable') }
        : null;
    // Write once at startup in two cases: a plain key (from an older
    // version or typed into the file) gets sealed now; and a file whose
    // unopenable values are safe in the copy drops them, so the next start
    // does not report and copy them again.
    const sealNow = opened.hadPlainSecrets && this.cipher.isAvailable();
    const dropLost = this.lostSecrets !== null && this.lostSecrets.backupPath !== null;
    if (sealNow || dropLost) {
      try {
        this.writeToDisk();
      } catch {
        // Not worth failing the start over; the next save tries again.
      }
    }
  }

  /** The current, always-complete config. */
  get(): AppConfig {
    return this.config;
  }

  /** The file this store persists to (the legacy-actions migration reads it raw). */
  get filePath(): string {
    return configFilePath();
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
   * Replaces the whole config with `next` (the Settings screen, which
   * always holds the full object), normalises it, persists, and returns
   * the stored result so the renderer adopts exactly what landed on disk.
   * Main-side partial writes go through `patch()`.
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

  /**
   * A main-process-side partial write (ADR-0074): merges `patch` into the
   * stored config and takes the same normalise/persist/notify path as
   * `set()`. First user: the update dialog's "Skip this version", decided
   * in a native dialog with no Settings screen involved. A concurrent
   * renderer draft can later overwrite the patched field — benign (the
   * next ask then re-offers the skipped version).
   */
  patch(patch: Partial<AppConfig>): AppConfig {
    return this.set({ ...this.config, ...patch });
  }

  private writeToDisk(): void {
    const filePath = configFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteFileSync(
      filePath,
      JSON.stringify(sealConfigSecrets(this.config, this.cipher), null, 2),
    );
  }
}
