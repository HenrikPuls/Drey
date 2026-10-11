import { Injectable, computed, inject, signal } from '@angular/core';
import { PaneService } from '../panes/pane.service';
import { VaultService } from '../vault';
import { OpenDoc, docKey, retargeted } from './open-doc';

/**
 * The registry of open documents: every tab's record (buffer, saved text,
 * kind, eol), kept in step with its pane placement, plus the status of the
 * work on them (loading, saving, last error). `EditorService` is the
 * facade the rest of the app reads; the services that open, save and
 * reload documents share this one store instead of each other.
 *
 * Tab placement itself belongs to `PaneService` (ADR-0037). The store only
 * makes sure the two never disagree: adding a doc opens its tab, removing
 * one closes it, a retarget renames it.
 */
@Injectable({ providedIn: 'root' })
export class OpenDocsStore {
  private readonly vault = inject(VaultService);
  private readonly panes = inject(PaneService);

  private readonly list = signal<OpenDoc[]>([]);

  /** Every open document, regardless of which pane shows it. */
  readonly docs = this.list.asReadonly();

  /** Tab key of the focused pane's active tab, or null when nothing is open. */
  readonly activeKey = computed<string | null>(() => this.panes.focusedPane()?.active ?? null);

  /** The focused pane's active document. */
  readonly activeDoc = computed<OpenDoc | null>(
    () => this.list().find((d) => d.key === this.activeKey()) ?? null,
  );

  readonly isLoading = signal(false);
  readonly isSaving = signal(false);
  readonly error = signal<string | null>(null);

  /** Records a failed read or write as the current error. */
  fail(err: unknown): void {
    this.error.set(err instanceof Error ? err.message : String(err));
  }

  has(key: string): boolean {
    return this.list().some((d) => d.key === key);
  }

  /** The `OpenDoc` whose TAB is `key`, or null if it isn't open. */
  docFor(key: string | null): OpenDoc | null {
    return key === null ? null : (this.list().find((d) => d.key === key) ?? null);
  }

  /**
   * Resolves a doc from what a caller may hold: a full tab key (panes,
   * session) or a bare vault-relative path (plugin-facing surfaces, which
   * never see keys). A bare path resolves to the active vault's doc first,
   * then -- when unambiguous -- to the one open doc with that path in any
   * vault. Returns null when it matches nothing (or would be ambiguous).
   */
  resolveDoc(keyOrPath: string): OpenDoc | null {
    const byKey = this.docFor(keyOrPath);
    if (byKey !== null) {
      return byKey;
    }
    const activeVaultId = this.vault.activeVaultId();
    if (activeVaultId !== null) {
      const inActive = this.docFor(docKey(activeVaultId, keyOrPath));
      if (inActive !== null) {
        return inActive;
      }
    }
    const matches = this.list().filter((d) => d.path === keyOrPath);
    return matches.length === 1 ? matches[0] : null;
  }

  /** Registers a document and opens its tab in the focused pane. */
  add(doc: OpenDoc): void {
    this.list.update((list) => [...list, doc]);
    this.panes.open(doc.key);
  }

  patch(key: string, patch: Partial<OpenDoc>): void {
    this.list.update((list) => list.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  }

  /**
   * Closes the tab and drops its buffer, without asking. Pane placement
   * goes first (it picks the neighbour to activate there) -- a document
   * lives in one pane at a time, so this closes its one and only tab.
   */
  remove(key: string): void {
    this.panes.closeEverywhere(key);
    this.list.update((list) => list.filter((d) => d.key !== key));
  }

  /**
   * A file or folder was renamed/moved on disk: re-point any open tab at
   * its new key, keeping the buffer so unsaved edits survive the rename.
   * Both arguments are full TAB KEYS (see {@link docKey}) -- a cross-vault
   * move retargets the tab into the other vault's namespace the same way a
   * folder rename moves it under a prefix. For a folder rename every tab
   * under it moves.
   */
  retarget(fromKey: string, toKey: string): void {
    const prefix = `${fromKey}/`;
    const remap = (key: string): string | null =>
      key === fromKey ? toKey : key.startsWith(prefix) ? toKey + key.slice(fromKey.length) : null;

    // Pane placement references the same key string, so re-point it there
    // before the registry's own key changes underneath it.
    for (const doc of this.list()) {
      const nextKey = remap(doc.key);
      if (nextKey !== null) {
        this.panes.renamePath(doc.key, nextKey);
      }
    }
    this.list.update((list) =>
      list.map((d) => {
        const nextKey = remap(d.key);
        return nextKey === null ? d : retargeted(d, nextKey);
      }),
    );
  }
}
