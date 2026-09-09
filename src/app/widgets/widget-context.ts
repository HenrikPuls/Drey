import { Injectable, Signal, computed, inject } from '@angular/core';
import type {
  TagEntry,
  TagSearchHit,
  TagSearchQuery,
  VaultFileEntry,
} from '../../../shared/ipc-api';
import type { TaskRecord } from '../../../shared/tasks';
import { Command, KeybindingService } from '../keybindings';
import { EditorService, OpenDoc } from '../services/editor.service';
import { EditTargetService } from '../services/edit-target.service';
import { TagService } from '../services/tag.service';
import { VaultService } from '../vault';

/** A text selection in the focused editor surface. */
export interface WidgetSelection {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

/**
 * The single typed surface a dock widget uses to reach the rest of the app
 * (ADR-0034): the active document, the vault file tree, and the standard
 * queries that already run in the system (tags, tasks, section search),
 * plus command registration. Thin delegation only -- every member forwards
 * to an existing `providedIn: 'root'` service or the IPC bridge, so a
 * widget depends on this one seam instead of a handful of services.
 *
 * There is no capability gating here; `WidgetDescriptor.capabilities` is
 * descriptive (shown in Settings, documented as the future enforcement
 * point). No runtime plugin loading, no sandbox -- an internal modular
 * seam, not a plugin host.
 */
@Injectable({ providedIn: 'root' })
export class WidgetContext {
  private readonly editor = inject(EditorService);
  private readonly editTarget = inject(EditTargetService);
  private readonly vault = inject(VaultService);
  private readonly tagService = inject(TagService);
  private readonly keys = inject(KeybindingService);

  // ---- active document ------------------------------------------------

  /** Vault-relative path of the active tab, or `null` when none is open. */
  readonly activeDocumentPath: Signal<string | null> = this.editor.openPath;
  /** File name of the active tab, or `null`. */
  readonly activeDocumentName = computed<string | null>(() => {
    const path = this.editor.openPath();
    return path ? (path.split('/').pop() ?? path) : null;
  });
  /** Contents of the active tab as last saved to disk. */
  readonly activeDocumentSaved: Signal<string> = this.editor.savedContent;
  /** Live editor buffer of the active tab (unsaved edits included). */
  readonly activeDocumentBuffer: Signal<string> = this.editor.bufferContent;
  /** `true` while the active tab has unsaved changes. */
  readonly activeDocumentDirty: Signal<boolean> = this.editor.isDirty;
  /** Every open tab, in tab order. */
  readonly openDocuments: Signal<readonly OpenDoc[]> = this.editor.openDocs;

  /** The current selection in the last-focused editor surface, or `null`. */
  selection(): WidgetSelection | null {
    const view = this.editTarget.view;
    if (!view) {
      return null;
    }
    const range = view.state.selection.main;
    return {
      from: range.from,
      to: range.to,
      text: range.empty ? '' : view.state.sliceDoc(range.from, range.to),
    };
  }

  /** Open a vault file (optionally at a 1-based line) in a tab. */
  openFile(path: string, line?: number): void {
    if (line == null) {
      void this.editor.openFile(path);
    } else {
      this.editor.openFileAt(path, line);
    }
  }

  // ---- vault file tree ----------------------------------------------

  /** The active vault's file tree (`templates/` and `daily/` included). */
  readonly fileTree: Signal<readonly VaultFileEntry[]> = this.vault.fileTree;
  /** Absolute path of the active vault, or `null`. */
  readonly activeVaultPath: Signal<string | null> = this.vault.activeVaultPath;

  /** Re-read the vault from disk and rebuild the tree (manual refresh, ADR-0018). */
  refreshVault(): Promise<void> {
    return this.vault.refresh();
  }

  // ---- standard queries -------------------------------------------

  /** The tag vocabulary with per-tag section counts. */
  readonly tags: Signal<readonly TagEntry[]> = this.tagService.tags;

  /** Run the main-process tag/section search (tags AND, free text AND). */
  searchSections(query: TagSearchQuery): Promise<TagSearchHit[]> {
    return typeof window !== 'undefined' && window.dreyApi
      ? window.dreyApi.searchTags(query)
      : Promise.resolve([]);
  }

  /** Every checkbox / `#task` line in the vault (`TaskIndex`). */
  listTasks(): Promise<readonly TaskRecord[]> {
    return typeof window !== 'undefined' && window.dreyApi
      ? window.dreyApi.listTasks()
      : Promise.resolve([]);
  }

  // ---- commands & lifecycle -------------------------------------

  /** Register a keyboard command (chord + label + handler). */
  registerCommand(command: Command): void {
    this.keys.register(command);
  }

  /**
   * Subscribe to "the vault changed on disk" (an MCP `vault_write` today).
   * Returns an unsubscribe function.
   */
  onVaultChanged(listener: () => void): () => void {
    return typeof window !== 'undefined' && window.dreyApi?.onVaultChanged
      ? window.dreyApi.onVaultChanged(listener)
      : () => {};
  }
}
