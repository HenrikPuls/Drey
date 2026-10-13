import * as fs from 'node:fs';
import * as path from 'node:path';
import { dailyPathFor } from '../shared/daily';
import { substitutePlaceholders } from '../shared/placeholders';
import { formatDate, formatDateTime, formatTime } from '../shared/timestamp';
import { AppConfigStore } from './app-config';
import { VaultManager } from './vault-manager';

/**
 * The daily template's vault-relative path. The literal `templates/` is a
 * structural folder (`specs/frontmatter-schema.md`), not the template
 * library folder the user can point elsewhere (`templates.dir`).
 */
const DAILY_TEMPLATE_PATH = 'templates/daily.md';

/**
 * Written to `templates/daily.md` the first time a daily note is created
 * and no template exists yet -- the user then edits this file to change
 * how new daily notes look. Kept verbatim (placeholders NOT substituted)
 * when scaffolded; substituted only when a daily note is created from it.
 *
 * Placeholders: `{{date}}` (2026-09-05), `{{time}}` (14:32),
 * `{{datetime}}` (2026-09-05T14:32:00), `{{title}}` (same as date).
 */
const STARTER_DAILY_TEMPLATE = `---
title: "{{title}}"
created: "{{datetime}}"
updated: "{{datetime}}"
---

# {{date}}

## {{time}}
`;

/**
 * Creates and locates per-day "daily notes" -- the target the
 * quick-capture hotkey opens in the editor (see `electron/main.ts`).
 *
 * This is a deliberate departure from `specs/roadmap.md`, which specified
 * a popup capture *window*. Per the project owner's call, capture now
 * means "jump into today's note in the full editor" instead. Daily notes
 * and the `templates/` folder are both new concepts vs. the specs; the
 * template mechanism is reused by milestone 5 when tag-routing creates
 * master/notiz files.
 *
 * Kept out of `VaultManager` on purpose: `VaultManager` is vault
 * registration + raw path-guarded file IO with no note/frontmatter
 * knowledge, and template substitution is exactly that knowledge. Every
 * file this class creates is still written by `VaultManager` -- atomic,
 * and entered in the own-write ledger like any other app write.
 */
export class DailyNoteManager {
  /**
   * The app config supplies the daily folder (`daily.dir`) at call time,
   * so a hotkey press always uses the current setting.
   */
  constructor(
    private readonly vaultManager: VaultManager,
    private readonly appConfig: AppConfigStore,
    /**
     * Told which files a call created. The watcher takes them for the
     * app's own writes and stays silent, so the caller runs the change
     * round (indexes + file tree) itself.
     */
    private readonly onCreated: (vaultId: string, paths: readonly string[]) => void = () =>
      undefined,
  ) {}

  /**
   * Vault-relative path (`<daily.dir>/2026/09/2026-09-05.md`) of today's
   * daily note, creating it -- plus the nested year/month folders and the
   * `templates/` folder and a starter `templates/daily.md` -- if it doesn't
   * exist yet. Rejects if no vault is active or the vault folder is gone.
   */
  async ensureTodayNote(now: Date = new Date()): Promise<string> {
    const vaultId = this.vaultManager.getActiveVaultId();
    const vaultRoot = this.vaultManager.getActiveVaultPath();
    if (!vaultId || !vaultRoot) {
      throw new Error('No vault is active.');
    }
    if (!fs.existsSync(vaultRoot)) {
      throw new Error(`Vault folder no longer exists: ${vaultRoot}`);
    }

    const relativePath = dailyPathFor(formatDate(now), this.appConfig.get().daily.dir);
    const absolutePath = path.join(vaultRoot, ...relativePath.split('/'));

    if (fs.existsSync(absolutePath)) {
      return relativePath;
    }

    const created: string[] = [];
    let template = await this.readTemplate(vaultId);
    if (template === null) {
      // First run for this vault: drop a starter template the user can
      // edit, and use it for this note.
      template = STARTER_DAILY_TEMPLATE;
      await this.vaultManager.writeFile(DAILY_TEMPLATE_PATH, template, vaultId);
      created.push(DAILY_TEMPLATE_PATH);
    }

    // Creates the nested `<daily.dir>/<year>/<month>/` folders on the way.
    await this.vaultManager.writeFile(relativePath, applyPlaceholders(template, now), vaultId);
    created.push(relativePath);
    this.onCreated(vaultId, created);
    return relativePath;
  }

  /**
   * The Markdown a fresh daily note for `dateStr` (`YYYY-MM-DD`) would
   * start from, WITHOUT touching the filesystem: the current
   * `templates/daily.md` (or the in-memory starter if the vault has none
   * yet -- deliberately not scaffolded here, this call must stay
   * side-effect free) with placeholders substituted. `{{date}}` /
   * `{{title}}` use `dateStr`; `{{time}}` / `{{datetime}}` use the current
   * wall-clock time, since the note is being written now even when
   * backdated from the calendar. Rejects if no vault is active or the date
   * is malformed.
   */
  async noteContentFor(dateStr: string): Promise<string> {
    const vaultId = this.vaultManager.getActiveVaultId();
    if (!vaultId) {
      throw new Error('No vault is active.');
    }
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
    if (!match) {
      throw new Error(`Not a YYYY-MM-DD date: ${dateStr}`);
    }

    const now = new Date();
    const when = new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      now.getHours(),
      now.getMinutes(),
      now.getSeconds(),
    );

    const template = (await this.readTemplate(vaultId)) ?? STARTER_DAILY_TEMPLATE;
    return applyPlaceholders(template, when);
  }

  /** The vault's `templates/daily.md`, or null when it has none. */
  private async readTemplate(vaultId: string): Promise<string | null> {
    try {
      return (await this.vaultManager.readFile(DAILY_TEMPLATE_PATH, vaultId)).content;
    } catch {
      return null;
    }
  }
}

/** Substitutes the daily-note placeholders. `{{title}}` is the date here. */
function applyPlaceholders(template: string, now: Date): string {
  return substitutePlaceholders(template, {
    date: formatDate(now),
    time: formatTime(now),
    datetime: formatDateTime(now),
    title: formatDate(now),
  });
}
