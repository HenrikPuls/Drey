import { Injectable, Signal, computed, signal } from '@angular/core';
import type { FileDecoration, FileDecorationTone } from '../../../shared/plugin-api/renderer';

/** What a Files-panel row shows: the tone always, a badge on files only. */
export interface RowDecoration {
  readonly tone: FileDecorationTone;
  readonly badge: string | null;
  readonly tooltip: string | null;
}

/** Which tone a folder shows when its descendants disagree: the highest wins. */
const TONE_RANK: Readonly<Record<FileDecorationTone, number>> = {
  untracked: 1,
  added: 2,
  deleted: 3,
  modified: 4,
  conflict: 5,
};

/**
 * The Files panel's row decorations (SDK 1.17): plugins hand in a list per
 * vault (`api.ui.setFileDecorations`), the panel reads one merged lookup.
 * The base knows nothing about where a decoration comes from -- the git
 * plugin is the first source.
 *
 * A folder inherits the strongest tone among its descendants, including
 * those that no longer exist on disk (a deleted file has no row, so its
 * folder is the only place the tree can show it).
 */
@Injectable({ providedIn: 'root' })
export class FileDecorationService {
  /** pluginId -> vaultId -> that plugin's decorations. */
  private readonly sources = signal<ReadonlyMap<string, ReadonlyMap<string, readonly FileDecoration[]>>>(
    new Map(),
  );

  /** vaultId -> path -> row decoration, files and inherited folders alike. */
  private readonly lookup: Signal<ReadonlyMap<string, ReadonlyMap<string, RowDecoration>>> = computed(() => {
    const out = new Map<string, Map<string, RowDecoration>>();
    for (const byVault of this.sources().values()) {
      for (const [vaultId, decorations] of byVault) {
        const rows = out.get(vaultId) ?? new Map<string, RowDecoration>();
        out.set(vaultId, rows);
        for (const decoration of decorations) {
          raise(rows, decoration.path, {
            tone: decoration.tone,
            badge: decoration.badge,
            tooltip: decoration.tooltip ?? null,
          });
          const parts = decoration.path.split('/');
          for (let i = 1; i < parts.length; i++) {
            raise(rows, parts.slice(0, i).join('/'), { tone: decoration.tone, badge: null, tooltip: null });
          }
        }
      }
    }
    return out;
  });

  /** Replaces one plugin's decorations for one vault; `null` / empty clears them. */
  set(pluginId: string, vaultId: string, decorations: readonly FileDecoration[] | null): void {
    this.sources.update((sources) => {
      const next = new Map(sources);
      const byVault = new Map(next.get(pluginId) ?? []);
      if (decorations === null || decorations.length === 0) {
        byVault.delete(vaultId);
      } else {
        byVault.set(vaultId, [...decorations]);
      }
      if (byVault.size === 0) {
        next.delete(pluginId);
      } else {
        next.set(pluginId, byVault);
      }
      return next;
    });
  }

  /** Drops everything one plugin contributed (deactivation, quarantine). */
  clear(pluginId: string): void {
    this.sources.update((sources) => {
      if (!sources.has(pluginId)) {
        return sources;
      }
      const next = new Map(sources);
      next.delete(pluginId);
      return next;
    });
  }

  /** The decoration of one tree row, or `null`. */
  decorationFor(vaultId: string, relativePath: string): RowDecoration | null {
    return this.lookup().get(vaultId)?.get(relativePath) ?? null;
  }
}

/** Keeps the stronger of the existing and the new decoration at `path`. */
function raise(rows: Map<string, RowDecoration>, path: string, next: RowDecoration): void {
  const current = rows.get(path);
  if (current === undefined || TONE_RANK[next.tone] > TONE_RANK[current.tone]) {
    rows.set(path, next);
  }
}
