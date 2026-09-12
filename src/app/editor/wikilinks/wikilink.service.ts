import { Injectable, computed, inject } from '@angular/core';
import { VaultFileEntry } from '../../../../shared/ipc-api';
import { EditorService } from '../../services/editor.service';
import { VaultService } from '../../vault';
import type { WikilinkCandidate } from './wikilink';

/**
 * Resolves and follows `[[wikilinks]]` (req-20). The note index is derived
 * from the vault file tree -- no vault-side index of its own (that is what
 * makes this a base feature, unlike the Tags plugin's vocabulary): a
 * lowercase basename -> paths map and a lowercase full-path map, recomputed
 * whenever the tree signal changes (open, refresh, own writes, the
 * ADR-0045 watcher push).
 *
 * Resolution (Obsidian-style): a target containing `/` or an extension is a
 * vault-relative path (`.md` appended when bare); anything else is a note
 * basename -- unique names win outright, ambiguous ones prefer a sibling in
 * the linking note's own folder, then the shortest path, then a plain
 * locale compare so the pick is deterministic. An empty target
 * (`[[#heading]]`) means the linking note itself.
 */

const MARKDOWN_FILE = /\.(md|markdown|mdx)$/i;

interface NoteIndex {
  /** lowercase full path -> real path */
  byPath: Map<string, string>;
  /** lowercase basename (no extension) -> real paths */
  byName: Map<string, string[]>;
  /** real paths, sorted */
  all: string[];
}

@Injectable({ providedIn: 'root' })
export class WikilinkService {
  private readonly vault = inject(VaultService);
  private readonly editor = inject(EditorService);

  private readonly index = computed<NoteIndex>(() => {
    const paths: string[] = [];
    const walk = (entries: readonly VaultFileEntry[]): void => {
      for (const entry of entries) {
        if (entry.type === 'directory') {
          walk(entry.children ?? []);
        } else if (MARKDOWN_FILE.test(entry.relativePath)) {
          paths.push(entry.relativePath);
        }
      }
    };
    walk(this.vault.fileTree());

    paths.sort((a, b) => a.localeCompare(b));
    const byPath = new Map<string, string>();
    const byName = new Map<string, string[]>();
    for (const path of paths) {
      byPath.set(path.toLowerCase(), path);
      const file = path.slice(path.lastIndexOf('/') + 1);
      const base = file.replace(/\.[^.]+$/, '').toLowerCase();
      const list = byName.get(base);
      if (list) {
        list.push(path);
      } else {
        byName.set(base, [path]);
      }
    }
    return { byPath, byName, all: paths };
  });

  /** Resolves a link target to a vault-relative path, or null when unknown. */
  resolve(rawTarget: string, fromPath: string | null): string | null {
    const target = rawTarget.trim();
    if (target === '') {
      // `[[#heading]]` -- the linking note itself.
      return fromPath;
    }
    const { byPath, byName } = this.index();
    if (target.includes('/') || /\.[^/]+$/.test(target)) {
      const key = (/\.[^/]+$/.test(target) ? target : `${target}.md`).toLowerCase();
      return byPath.get(key) ?? null;
    }
    const hits = byName.get(target.toLowerCase());
    if (!hits || hits.length === 0) {
      return null;
    }
    if (hits.length === 1) {
      return hits[0];
    }
    // Ambiguous basename: prefer a sibling of the linking note, then the
    // shortest path (both deterministic -- `all` is pre-sorted for the
    // locale-compare tie-break).
    const fromDir =
      fromPath && fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
    const sibling = hits.find((p) => parentDir(p) === fromDir);
    if (sibling) {
      return sibling;
    }
    return [...hits].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  }

  /** The flattened note list for the `[[` completion popup. */
  noteNames(): WikilinkCandidate[] {
    const { all, byName } = this.index();
    return all.map((path) => {
      const file = path.slice(path.lastIndexOf('/') + 1);
      const dot = file.lastIndexOf('.');
      const name = dot > 0 ? file.slice(0, dot) : file;
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      const unique = (byName.get(name.toLowerCase())?.length ?? 0) === 1;
      return { name, path, dir, target: unique ? name : path.replace(/\.[^.]+$/, '') };
    });
  }

  /**
   * The full editor flow: open the resolved note (at the `#heading` anchor
   * when given), or -- when nothing resolves -- create the note (`.md`
   * appended; parents auto-created by `VaultManager.createFile`) and open
   * it. An "already exists" race (the file appeared between resolve and
   * create) just opens it.
   */
  async open(target: string, anchor: string | null, fromPath: string | null): Promise<void> {
    const resolved = this.resolve(target, fromPath);
    if (resolved !== null) {
      await this.openAt(resolved, anchor);
      return;
    }
    await this.createAndOpen(target);
  }

  /** The entry-drawer flow: follow existing references only -- the drawer
   * body is not yet a document, so it must not mint files. */
  async openResolvedOnly(target: string, anchor: string | null): Promise<void> {
    const resolved = this.resolve(target, null);
    if (resolved !== null) {
      await this.openAt(resolved, anchor);
    }
  }

  private async openAt(path: string, anchor: string | null): Promise<void> {
    const line = anchor !== null ? await this.headingLine(path, anchor) : 1;
    await this.editor.openFileAt(path, line ?? 1);
  }

  /**
   * The 1-based line of a heading matching `anchor` (case-insensitive,
   * closing `#`s allowed) -- the open buffer first, so unsaved edits count,
   * else the file from disk. Null when the note has no such heading (the
   * caller opens at the top).
   */
  private async headingLine(path: string, anchor: string): Promise<number | null> {
    let text: string | null = this.editor.docFor(path)?.bufferContent ?? null;
    if (text === null) {
      try {
        text = await this.vault.readTextFile(path);
      } catch {
        return null;
      }
    }
    const escaped = anchor.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`^#{1,6}[ \\t]+${escaped}[ \\t]*#*[ \\t]*$`, 'im').exec(text);
    if (!match) {
      return null;
    }
    return text.slice(0, match.index).split('\n').length;
  }

  private async createAndOpen(target: string): Promise<void> {
    const clean = target.trim();
    if (
      clean === '' ||
      clean.includes('\\') ||
      clean.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      this.editor.error.set(`Cannot create a note for [[${target}]].`);
      return;
    }
    const path = /\.[^/]+$/.test(clean) ? clean : `${clean}.md`;
    try {
      await this.vault.createEntry('file', path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Lost a race -- the file exists by now; opening it is still right.
      if (!/already exists/i.test(message)) {
        this.editor.error.set(message);
        return;
      }
    }
    await this.editor.openFile(path);
  }
}

function parentDir(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}
