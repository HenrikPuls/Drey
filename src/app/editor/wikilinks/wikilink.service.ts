import { Injectable, computed, inject } from '@angular/core';
import { VaultFileEntry } from '../../../../shared/ipc-api';
import { EditorService, docKey } from '../../services/editor.service';
import { VaultService } from '../../vault';
import type { WikilinkCandidate } from './wikilink';

/**
 * Resolves and follows `[[wikilinks]]` (req-20). The note index is derived
 * from the vault file trees -- no vault-side index of its own (that is what
 * makes this a base feature, unlike the Tags plugin's vocabulary): a
 * lowercase basename -> paths map and a lowercase full-path map, recomputed
 * whenever the tree signals change (open, refresh, own writes, the
 * ADR-0045 watcher push).
 *
 * Since ADR-0051 there is one index PER REGISTERED VAULT, and resolution is
 * scoped to the linking note's own vault: a `[[link]]` in a vault-B note
 * resolves inside vault B, and a missing target is created there too (a
 * note created in another vault would leave the link permanently
 * unresolved). Vault-less documents (scratch tabs like the search summary)
 * resolve through a MERGED index over all registered vaults -- the active
 * vault wins path collisions and basename ambiguities -- and never mint
 * files: there is no vault a created note would deterministically belong
 * to. Opening from the merged index targets the OWNING vault, which
 * `vaultOf` remembers per path.
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

/** A merged index additionally remembers which vault each path lives in. */
interface MergedIndex extends NoteIndex {
  /** real path -> vault id */
  vaultOf: Map<string, string>;
}

const EMPTY_INDEX: NoteIndex = { byPath: new Map(), byName: new Map(), all: [] };

@Injectable({ providedIn: 'root' })
export class WikilinkService {
  private readonly vault = inject(VaultService);
  private readonly editor = inject(EditorService);

  /** One note index per registered vault, keyed by vault id (ADR-0051). */
  private readonly indexes = computed<Record<string, NoteIndex>>(() => {
    const out: Record<string, NoteIndex> = {};
    for (const [vaultId, tree] of Object.entries(this.vault.trees())) {
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
      walk(tree);

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
      out[vaultId] = { byPath, byName, all: paths };
    }
    return out;
  });

  private indexFor(vaultId: string | null): NoteIndex {
    if (vaultId === null) {
      return this.mergedIndex();
    }
    return this.indexes()[vaultId] ?? EMPTY_INDEX;
  }

  /**
   * The union of every registered vault's index, for VAULT-LESS documents
   * (scratch tabs like the search summary). The active vault is merged
   * first, so it wins both path collisions and basename ambiguity -- one
   * deterministic target per link. `vaultOf` records where each path
   * actually lives, because opening must target the owning vault, not the
   * active one.
   */
  private readonly mergedIndex = computed<MergedIndex>(() => {
    const perVault = this.indexes();
    const active = this.vault.activeVaultId();
    const order: string[] = [];
    if (active !== null && perVault[active] !== undefined) {
      order.push(active);
    }
    for (const vaultId of Object.keys(perVault)) {
      if (vaultId !== active) {
        order.push(vaultId);
      }
    }
    const byPath = new Map<string, string>();
    const names = new Map<string, Set<string>>();
    const vaultOf = new Map<string, string>();
    for (const vaultId of order) {
      const index = perVault[vaultId];
      for (const [key, path] of index.byPath) {
        if (!byPath.has(key)) {
          byPath.set(key, path);
          vaultOf.set(path, vaultId);
        }
      }
      for (const [key, paths] of index.byName) {
        let list = names.get(key);
        if (list === undefined) {
          list = new Set<string>();
          names.set(key, list);
        }
        for (const path of paths) {
          list.add(path);
        }
      }
    }
    const all = [...byPath.values()].sort((a, b) => a.localeCompare(b));
    const byName = new Map<string, string[]>(
      [...names].map(([key, paths]) => [key, [...paths]] as const),
    );
    return { byPath, byName, all, vaultOf };
  });

  /**
   * Resolves a link target to a vault-relative path (inside `fromVaultId` --
   * the linking note's vault, or the merged cross-vault index when null),
   * or null when unknown.
   */
  resolve(rawTarget: string, fromVaultId: string | null, fromPath: string | null): string | null {
    const target = rawTarget.trim();
    if (target === '') {
      // `[[#heading]]` -- the linking note itself.
      return fromPath;
    }
    const { byPath, byName } = this.indexFor(fromVaultId);
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

  /** The flattened note list of `vaultId`'s vault for the `[[` completion popup. */
  noteNames(vaultId: string | null): WikilinkCandidate[] {
    const { all, byName } = this.indexFor(vaultId);
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
   * appended; parents auto-created by `VaultManager.createFile`) in the
   * LINKING NOTE'S vault and open it. An "already exists" race (the file
   * appeared between resolve and create) just opens it. Vault-less
   * documents (scratch tabs) never create: the merged index decides where
   * an existing note opens, and an unknown target is reported, not minted.
   */
  async open(
    target: string,
    anchor: string | null,
    fromVaultId: string | null,
    fromPath: string | null,
  ): Promise<void> {
    const located = this.locate(target, fromVaultId, fromPath);
    if (located !== null) {
      await this.openAt(located.path, anchor, located.vaultId);
      return;
    }
    if (fromVaultId === null) {
      if (target.trim() !== '') {
        this.editor.error.set(`Cannot follow [[${target}]] — no note matches.`);
      }
      return;
    }
    await this.createAndOpen(target, fromVaultId);
  }

  /**
   * Resolves a link target to WHERE it lives -- the owning vault's id plus
   * the vault-relative path -- or null when unknown. Vault-scoped documents
   * resolve inside their own vault (ADR-0051); vault-less ones go through
   * the merged index and look their path's owning vault up in `vaultOf`.
   */
  private locate(
    rawTarget: string,
    fromVaultId: string | null,
    fromPath: string | null,
  ): { vaultId: string; path: string } | null {
    const resolved = this.resolve(rawTarget, fromVaultId, fromPath);
    if (resolved === null) {
      return null;
    }
    if (fromVaultId !== null) {
      return { vaultId: fromVaultId, path: resolved };
    }
    const vaultId = this.mergedIndex().vaultOf.get(resolved);
    return vaultId === undefined ? null : { vaultId, path: resolved };
  }

  /** The entry-drawer flow: follow existing references only -- the drawer
   * body is not yet a document, so it must not mint files. Resolves in the
   * ACTIVE vault. */
  async openResolvedOnly(target: string, anchor: string | null): Promise<void> {
    const resolved = this.resolve(target, this.vault.activeVaultId(), null);
    if (resolved !== null) {
      await this.openAt(resolved, anchor, this.vault.activeVaultId());
    }
  }

  private async openAt(path: string, anchor: string | null, vaultId: string | null): Promise<void> {
    const line = anchor !== null ? await this.headingLine(path, anchor, vaultId) : 1;
    await this.editor.openFileAt(path, line ?? 1, vaultId ?? undefined);
  }

  /**
   * The 1-based line of a heading matching `anchor` (case-insensitive,
   * closing `#`s allowed) -- the open buffer first, so unsaved edits count,
   * else the file from disk. Null when the note has no such heading (the
   * caller opens at the top).
   */
  private async headingLine(
    path: string,
    anchor: string,
    vaultId: string | null,
  ): Promise<number | null> {
    let text: string | null = this.editor.docFor(docKey(vaultId, path))?.bufferContent ?? null;
    if (text === null) {
      try {
        text = await this.vault.readTextFile(path, vaultId ?? undefined);
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

  /** Creates the note in `vaultId`'s vault (the active one when null) and opens it. */
  private async createAndOpen(target: string, vaultId: string | null): Promise<void> {
    const clean = target.trim();
    if (
      clean === '' ||
      clean.includes('\\') ||
      clean.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      this.editor.error.set(`Cannot create a note for [[${target}]].`);
      return;
    }
    const resolvedVaultId = vaultId ?? this.vault.activeVaultId();
    if (resolvedVaultId === null) {
      this.editor.error.set('No vault is active.');
      return;
    }
    const path = /\.[^/]+$/.test(clean) ? clean : `${clean}.md`;
    try {
      await this.vault.createEntry('file', path, resolvedVaultId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Lost a race -- the file exists by now; opening it is still right.
      if (!/already exists/i.test(message)) {
        this.editor.error.set(message);
        return;
      }
    }
    await this.editor.openFile(path, resolvedVaultId);
  }
}

function parentDir(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}
