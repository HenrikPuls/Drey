import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { formatDate, formatDateTime, formatTime } from '../shared/timestamp';
import { VaultManager } from './vault-manager';

const DAILY_DIR = 'daily';
const TEMPLATE_DIR = 'templates';
const DAILY_TEMPLATE_FILE = 'daily.md';

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
type: notiz
title: "{{title}}"
tags: ["daily"]
created: "{{date}}"
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
 * knowledge, and template substitution is exactly that knowledge.
 */
export class DailyNoteManager {
  constructor(private readonly vaultManager: VaultManager) {}

  /**
   * Vault-relative path (`daily/2026-09-05.md`) of today's daily note,
   * creating it -- plus the `daily/` and `templates/` folders and a
   * starter `templates/daily.md` -- if it doesn't exist yet. Rejects if
   * no vault is active or the vault folder is gone.
   */
  async ensureTodayNote(now: Date = new Date()): Promise<string> {
    const vaultRoot = this.vaultManager.getActiveVaultPath();
    if (!vaultRoot) {
      throw new Error('No vault is active.');
    }
    if (!fs.existsSync(vaultRoot)) {
      throw new Error(`Vault folder no longer exists: ${vaultRoot}`);
    }

    const fileName = `${formatDate(now)}.md`;
    const relativePath = `${DAILY_DIR}/${fileName}`;
    const absolutePath = path.join(vaultRoot, DAILY_DIR, fileName);

    if (fs.existsSync(absolutePath)) {
      return relativePath;
    }

    const template = await this.loadOrScaffoldTemplate(vaultRoot);
    const content = applyPlaceholders(template, now);

    await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
    await fsp.writeFile(absolutePath, content, 'utf-8');
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
    const vaultRoot = this.vaultManager.getActiveVaultPath();
    if (!vaultRoot) {
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

    const template = await this.readTemplate(vaultRoot);
    return applyPlaceholders(template, when);
  }

  /** Current `templates/daily.md`, or the starter if none exists -- no write. */
  private async readTemplate(vaultRoot: string): Promise<string> {
    try {
      return await fsp.readFile(path.join(vaultRoot, TEMPLATE_DIR, DAILY_TEMPLATE_FILE), 'utf-8');
    } catch {
      return STARTER_DAILY_TEMPLATE;
    }
  }

  private async loadOrScaffoldTemplate(vaultRoot: string): Promise<string> {
    const templatePath = path.join(vaultRoot, TEMPLATE_DIR, DAILY_TEMPLATE_FILE);
    try {
      return await fsp.readFile(templatePath, 'utf-8');
    } catch {
      // First run for this vault: drop a starter template the user can
      // edit, and use it for this note.
      await fsp.mkdir(path.dirname(templatePath), { recursive: true });
      await fsp.writeFile(templatePath, STARTER_DAILY_TEMPLATE, 'utf-8');
      return STARTER_DAILY_TEMPLATE;
    }
  }
}

/** Replaces `{{key}}` for the known keys; leaves any unknown token as-is. */
function applyPlaceholders(template: string, now: Date): string {
  const values: Record<string, string> = {
    date: formatDate(now),
    time: formatTime(now),
    datetime: formatDateTime(now),
    title: formatDate(now),
  };
  return template.replace(/\{\{(\w+)\}\}/g, (token, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : token,
  );
}
