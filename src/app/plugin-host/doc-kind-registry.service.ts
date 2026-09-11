import { Injectable, inject, signal } from '@angular/core';
import type { PluginDocKindContrib, Unsubscribe } from '../../../shared/plugin-api/renderer';
import { LogService } from '../services/log.service';

/**
 * The doc-kind seam (ADR-0044 stage 8A): every open tab that is neither a
 * text buffer nor an image viewer resolves through this registry — every
 * kind is plugin-contributed (the browser since stage 8B, the sample
 * clock, …). The pane body (`PaneLeaf`), the tab strip's favicon and the
 * status-bar line all read the contribution instead of switching on a
 * hardcoded kind.
 *
 * The map is a signal so consumers' `computed`s re-run when a kind (un-)
 * registers. `favicon`/`statusText` calls are guarded: a throwing plugin
 * callback must not break the tab strip or the status bar.
 */
@Injectable({ providedIn: 'root' })
export class DocKindRegistry {
  private readonly log = inject(LogService);

  private readonly contribs = signal<ReadonlyMap<string, PluginDocKindContrib>>(new Map());

  /**
   * Bumped on (un)registration — and, from `PluginHostService`, whenever a
   * document/visibility event lands. Plugin kinds answer `favicon`/
   * `statusText` from plain plugin state (nothing the shell could track),
   * so the tab strip / status bar re-read them on this tick (the widget
   * `statusTick` pattern).
   */
  private readonly revision = signal(0);
  bump(): void {
    this.revision.update((v) => v + 1);
  }

  register(contrib: PluginDocKindContrib): Unsubscribe {
    if (this.contribs().has(contrib.kind)) {
      this.log.record('warn', `doc kind "${contrib.kind}" registered twice — later wins`);
    }
    this.contribs.update((map) => new Map(map).set(contrib.kind, contrib));
    this.revision.update((v) => v + 1);
    return () => {
      this.contribs.update((map) => {
        const next = new Map(map);
        if (next.get(contrib.kind) === contrib) {
          next.delete(contrib.kind);
        }
        return next;
      });
      this.revision.update((v) => v + 1);
    };
  }

  get(kind: string): PluginDocKindContrib | undefined {
    this.revision(); // tracked: consumers re-run when kinds (un)register or plugin state ticks
    return this.contribs().get(kind);
  }

  /** Guarded tab-strip favicon; null when the kind has none or the call fails. */
  faviconFor(kind: string, path: string): string | null {
    const favicon = this.get(kind)?.favicon;
    if (favicon === undefined) {
      return null;
    }
    try {
      return favicon(path) ?? null;
    } catch (error) {
      this.log.record('error', `doc kind "${kind}" favicon failed: ${String(error)}`);
      return null;
    }
  }

  /** Guarded status-bar text; null when the kind has none or the call fails. */
  statusTextFor(kind: string, path: string): string | null {
    const statusText = this.get(kind)?.statusText;
    if (statusText === undefined) {
      return null;
    }
    try {
      return statusText(path) ?? null;
    } catch (error) {
      this.log.record('error', `doc kind "${kind}" statusText failed: ${String(error)}`);
      return null;
    }
  }
}
