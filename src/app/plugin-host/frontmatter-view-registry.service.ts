import { Injectable, inject, signal } from '@angular/core';
import type {
  EditorSurfaceContext,
  FrontmatterViewContrib,
  Unsubscribe,
} from '../../../shared/plugin-api/renderer';
import { LogService } from '../services/log.service';

interface RegisteredFrontmatterView {
  readonly owner: string;
  readonly contrib: FrontmatterViewContrib;
}

/**
 * The frontmatter-view seam (SDK 1.34): a plugin may present a document's
 * frontmatter in place of the base's folded pill. The frontmatter fold asks
 * `find` on every rebuild; `revision` changes on (de)registration so open
 * surfaces redraw. A `matches` that throws is skipped and logged.
 */
@Injectable({ providedIn: 'root' })
export class FrontmatterViewRegistry {
  private readonly log = inject(LogService);
  private readonly entries = signal<readonly RegisteredFrontmatterView[]>([]);
  private readonly counter = signal(0);

  /** Changes on every registration/unregistration — surfaces watch this. */
  readonly revision = this.counter.asReadonly();

  register(owner: string, contrib: FrontmatterViewContrib): Unsubscribe {
    const entry: RegisteredFrontmatterView = { owner, contrib };
    this.entries.update((list) => [...list, entry]);
    this.counter.update((n) => n + 1);
    return () => {
      this.entries.update((list) => list.filter((e) => e !== entry));
      this.counter.update((n) => n + 1);
    };
  }

  /** The first view whose `matches` holds for this surface, or null. */
  find(context: EditorSurfaceContext): FrontmatterViewContrib | null {
    for (const entry of this.entries()) {
      try {
        if (entry.contrib.matches(context)) {
          return entry.contrib;
        }
      } catch (error) {
        this.log.record('error', `plugin "${entry.owner}" frontmatter view failed: ${String(error)}`);
      }
    }
    return null;
  }
}
