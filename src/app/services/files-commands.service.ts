import { Injectable } from '@angular/core';
import type {
  FilesContextMenuItem,
  FilesContextMenuTarget,
  Unsubscribe,
} from '../../../shared/plugin-api/renderer';

/** One plugin's context-menu contribution callback (`api.files.registerContextMenuItems`). */
export type FilesContextMenuContributor = (
  target: FilesContextMenuTarget,
) => readonly FilesContextMenuItem[];

/**
 * Plugin-contributed rows for the Files-panel context menus (SDK 1.32):
 * one sync callback per plugin, re-evaluated on every menu open over the
 * plugin's cached state so rows can be target-scoped (specific vaults or
 * folders). The panel appends the rows after its built-ins.
 */
@Injectable({ providedIn: 'root' })
export class FilesCommandsService {
  /** pluginId -> contributor; Map iteration order = row order. */
  private readonly contributors = new Map<string, FilesContextMenuContributor>();

  register(pluginId: string, contributor: FilesContextMenuContributor): Unsubscribe {
    this.contributors.set(pluginId, contributor);
    return () => {
      // A later registration replaced this plugin's slot — keep that one.
      if (this.contributors.get(pluginId) === contributor) {
        this.contributors.delete(pluginId);
      }
    };
  }

  /** Drops one plugin's contributor (deactivation, quarantine). */
  clear(pluginId: string): void {
    this.contributors.delete(pluginId);
  }

  /**
   * All plugin rows for one menu open, registration order. Deliberately a
   * METHOD, not a computed: the callback form is re-evaluated per open. A
   * throwing contributor contributes nothing (same defensive stance as
   * `EditorContextMenuRegistry`) — one broken plugin must never blank the
   * whole menu.
   */
  itemsFor(target: FilesContextMenuTarget): readonly FilesContextMenuItem[] {
    const out: FilesContextMenuItem[] = [];
    for (const contribute of this.contributors.values()) {
      try {
        out.push(...contribute(target));
      } catch {
        // a broken plugin contributes nothing this open
      }
    }
    return out;
  }
}
