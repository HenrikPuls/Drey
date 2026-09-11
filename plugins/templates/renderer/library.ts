import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import {
  formatDateTime,
  formatDate,
  formatTime,
  stripFrontmatter,
  substitutePlaceholders,
} from './pure.js';

/**
 * The template library (ADR-0029), plugin-side: the configured vault folder
 * rendered as a category tree, recents tracking, and insert-at-cursor.
 * Ported from `src/app/templates/template-library.service.ts` — the logic is
 * identical, the host access goes through the plugin API.
 */

export interface TemplateEntry {
  name: string;
  /** Vault-relative path, forward-slash, e.g. `templates/meetings/1-1.md`. */
  relativePath: string;
}

export interface TemplateCategory {
  name: string;
  path: string;
  templates: TemplateEntry[];
  children: TemplateCategory[];
}

const RECENT_KEY = 'drey.templates.recent';
const RECENT_MAX = 5;
const GENERAL = 'General';

interface FileNode {
  name: string;
  relativePath: string;
  type: 'file' | 'directory';
  children?: FileNode[];
}

function isMarkdown(entry: FileNode): boolean {
  return entry.type === 'file' && /\.md$/i.test(entry.name);
}

function labelOf(entry: FileNode): string {
  return entry.name.replace(/\.md$/i, '');
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

function findDir(tree: readonly FileNode[], dir: string): FileNode | null {
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

function toCategory(node: FileNode): TemplateCategory {
  const children = node.children ?? [];
  return {
    name: node.name,
    path: node.relativePath,
    templates: children.filter(isMarkdown).map(toEntry).sort(byName),
    children: children.filter((c) => c.type === 'directory').map(toCategory).sort(byName),
  };
}

function toEntry(entry: FileNode): TemplateEntry {
  return { name: labelOf(entry), relativePath: entry.relativePath };
}

function buildCategories(root: FileNode, dir: string): TemplateCategory[] {
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

export function flatten(categories: readonly TemplateCategory[]): TemplateEntry[] {
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

export function readRecent(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
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

/** The library state one plugin instance carries: dir, tree, recents, listeners. */
export class TemplateLibrary {
  dir = 'templates';
  categories: TemplateCategory[] = [];
  recentPaths: string[] = readRecent();
  private readonly listeners = new Set<() => void>();

  constructor(readonly api: DreyPluginApi) {}

  /** Re-reads the configured folder + file tree; notifies the UI. */
  async reload(): Promise<void> {
    try {
      const config = await this.api.appConfig.get();
      this.dir = config.templates.dir;
      const tree = await this.api.vault.listFiles();
      const root = findDir(tree, this.dir);
      this.categories = root ? buildCategories(root, this.dir) : [];
    } catch {
      this.categories = [];
    }
    this.notify();
  }

  get all(): TemplateEntry[] {
    return flatten(this.categories);
  }

  /** The last few inserted templates that still exist, most-recent first. */
  get recent(): TemplateEntry[] {
    const known = this.all;
    return this.recentPaths
      .map((p) => known.find((t) => t.relativePath === p))
      .filter((t): t is TemplateEntry => t !== undefined)
      .slice(0, RECENT_MAX);
  }

  /** Shows the recent list as leading entries of the flat list (picker order). */
  orderedForPicker(): TemplateEntry[] {
    const recent = this.recent;
    const recentPaths = new Set(recent.map((t) => t.relativePath));
    const all = this.all;
    const rest = all.filter((t) => !recentPaths.has(t.relativePath));
    return recent.length > 0 ? [...recent, ...rest] : all;
  }

  filter(query: string): TemplateEntry[] {
    const q = query.trim().toLowerCase();
    if (q === '') {
      return this.orderedForPicker();
    }
    return this.all.filter(
      (t) => t.name.toLowerCase().includes(q) || t.relativePath.toLowerCase().includes(q),
    );
  }

  /**
   * Reads the template, strips frontmatter, substitutes placeholders, and
   * inserts at the cursor. Returns false (with a message) when no text
   * document is active.
   */
  async insert(relativePath: string): Promise<{ ok: boolean; message?: string }> {
    const active = this.api.documents.active();
    if (active === null || active.kind !== 'text') {
      return { ok: false, message: 'Open a note before inserting a template.' };
    }
    const file = await this.api.vault.readFile(relativePath);
    const body = substitutePlaceholders(stripFrontmatter(file.content), this.placeholders(active.path));
    if (!this.api.documents.insertAtCursor(body)) {
      return { ok: false, message: 'Open a note before inserting a template.' };
    }
    this.pushRecent(relativePath);
    return { ok: true };
  }

  private placeholders(activePath: string): Record<string, string> {
    const now = new Date();
    const title = (activePath.split('/').pop() ?? '').replace(/\.md$/i, '');
    return {
      date: formatDate(now),
      time: formatTime(now),
      datetime: formatDateTime(now),
      title,
    };
  }

  private pushRecent(relativePath: string): void {
    this.recentPaths = [relativePath, ...this.recentPaths.filter((p) => p !== relativePath)].slice(
      0,
      RECENT_MAX,
    );
    writeRecent(this.recentPaths);
    this.notify();
  }

  /** UI change notification (tree/recents changed). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}
