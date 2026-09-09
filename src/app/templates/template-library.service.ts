import { Injectable, Signal, computed, inject, signal } from '@angular/core';
import { substitutePlaceholders } from '../../../shared/placeholders';
import { formatDate, formatDateTime, formatTime } from '../../../shared/timestamp';
import { VaultFileEntry } from '../../../shared/ipc-api';
import { EditorService } from '../services/editor.service';
import { SettingsService } from '../services/settings.service';
import { VaultService } from '../services/vault.service';
import { stripFrontmatter } from '../editor/markdown-frontmatter';

/** One template file. `name` (filename minus `.md`) is the label shown everywhere. */
export interface TemplateEntry {
  name: string;
  /** Vault-relative path, forward-slash, e.g. `templates/meetings/1-1.md`. */
  relativePath: string;
}

/**
 * A folder under the templates directory. Files sitting directly in the
 * templates root are collected into a synthetic `General` category.
 */
export interface TemplateCategory {
  name: string;
  /** Vault-relative folder path (the templates dir itself for `General`). */
  path: string;
  templates: TemplateEntry[];
  children: TemplateCategory[];
}

const RECENT_KEY = 'drey.templates.recent';
const RECENT_MAX = 5;
const GENERAL = 'General';

function isMarkdown(entry: VaultFileEntry): boolean {
  return entry.type === 'file' && /\.md$/i.test(entry.name);
}

function labelOf(entry: VaultFileEntry): string {
  return entry.name.replace(/\.md$/i, '');
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

/** Depth-first lookup of the directory node whose `relativePath` equals `dir`. */
function findDir(tree: readonly VaultFileEntry[], dir: string): VaultFileEntry | null {
  for (const entry of tree) {
    if (entry.type !== 'directory') {
      continue;
    }
    if (entry.relativePath === dir) {
      return entry;
    }
    if (dir.startsWith(entry.relativePath + '/') && entry.children) {
      const hit = findDir(entry.children, dir);
      if (hit) {
        return hit;
      }
    }
  }
  return null;
}

/** A sub-directory node -> a `TemplateCategory` (recursively). */
function toCategory(node: VaultFileEntry): TemplateCategory {
  const children = node.children ?? [];
  return {
    name: node.name,
    path: node.relativePath,
    templates: children.filter(isMarkdown).map(toEntry).sort(byName),
    children: children.filter((c) => c.type === 'directory').map(toCategory).sort(byName),
  };
}

function toEntry(entry: VaultFileEntry): TemplateEntry {
  return { name: labelOf(entry), relativePath: entry.relativePath };
}

function buildCategories(root: VaultFileEntry, dir: string): TemplateCategory[] {
  const children = root.children ?? [];
  const loose = children.filter(isMarkdown).map(toEntry).sort(byName);
  const subs = children
    .filter((c) => c.type === 'directory')
    .map(toCategory)
    .sort(byName);
  const general: TemplateCategory[] =
    loose.length > 0 ? [{ name: GENERAL, path: dir, templates: loose, children: [] }] : [];
  return [...general, ...subs];
}

function flatten(categories: readonly TemplateCategory[]): TemplateEntry[] {
  const out: TemplateEntry[] = [];
  const walk = (cats: readonly TemplateCategory[]): void => {
    for (const cat of cats) {
      out.push(...cat.templates);
      walk(cat.children);
    }
  };
  walk(categories);
  return out;
}

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list = JSON.parse(raw ?? '[]') as unknown;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeRecent(list: readonly string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Private-mode / storage-disabled: a non-persisted session is fine.
  }
}

/**
 * The template library: reads the configured vault sub-folder as a
 * category tree, tracks the last few templates used, and inserts one into
 * the active note (frontmatter stripped, `{{date}}`/`{{time}}`/
 * `{{datetime}}`/`{{title}}` substituted).
 *
 * No new filesystem IPC -- it reads `VaultService.fileTree()` (already
 * loaded and refreshed on every vault change) and `VaultService.readTextFile()`.
 */
@Injectable({ providedIn: 'root' })
export class TemplateLibraryService {
  private readonly vault = inject(VaultService);
  private readonly settings = inject(SettingsService);
  private readonly editor = inject(EditorService);

  /** The category tree under the configured templates folder. */
  readonly categories: Signal<TemplateCategory[]> = computed(() => {
    const dir = this.settings.templatesDir();
    const root = findDir(this.vault.fileTree(), dir);
    return root ? buildCategories(root, dir) : [];
  });

  /** Flat list of every template, for the picker's search and `recent()`. */
  readonly all: Signal<TemplateEntry[]> = computed(() => flatten(this.categories()));

  private readonly recentPaths = signal<string[]>(readRecent());

  /** The last few inserted templates that still exist, most-recent first. */
  readonly recent: Signal<TemplateEntry[]> = computed(() => {
    const known = this.all();
    return this.recentPaths()
      .map((p) => known.find((t) => t.relativePath === p))
      .filter((t): t is TemplateEntry => t !== undefined)
      .slice(0, RECENT_MAX);
  });

  readonly pickerOpen = signal(false);

  openPicker(): void {
    this.pickerOpen.set(true);
  }

  closePicker(): void {
    this.pickerOpen.set(false);
  }

  /**
   * Reads the template, strips a leading YAML frontmatter block, substitutes
   * placeholders, and inserts the result at the cursor (replacing any
   * selection). No-op with no active text document.
   */
  async insert(relativePath: string): Promise<void> {
    if (this.editor.activePath() === null || this.editor.activeKind() === 'image') {
      this.editor.error.set('Open a note before inserting a template.');
      return;
    }
    try {
      const raw = await this.vault.readTextFile(relativePath);
      const body = substitutePlaceholders(stripFrontmatter(raw), this.placeholders());
      this.editor.requestInsertText(body);
      this.pushRecent(relativePath);
    } catch (err) {
      this.editor.error.set(err instanceof Error ? err.message : String(err));
    }
  }

  private placeholders(): Record<string, string> {
    const now = new Date();
    const active = this.editor.activePath();
    const title = active ? (active.split('/').pop() ?? '').replace(/\.md$/i, '') : '';
    return {
      date: formatDate(now),
      time: formatTime(now),
      datetime: formatDateTime(now),
      title,
    };
  }

  private pushRecent(relativePath: string): void {
    this.recentPaths.update((cur) =>
      [relativePath, ...cur.filter((p) => p !== relativePath)].slice(0, RECENT_MAX),
    );
    writeRecent(this.recentPaths());
  }
}
