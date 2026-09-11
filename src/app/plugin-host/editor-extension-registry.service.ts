import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  EditorExtensionSlot,
  EditorSurfaceContext,
  Unsubscribe,
} from '../../../shared/plugin-api/renderer';
import { LogService } from '../services/log.service';

interface RegisteredExtension {
  readonly owner: string;
  readonly slot: EditorExtensionSlot;
  readonly factory: (context: EditorSurfaceContext) => unknown;
}

/**
 * The editor-extension seam (ADR-0044 stage 2): plugins contribute
 * CodeMirror extensions per surface slot (`document` / `composer` /
 * `both`); `MarkdownSurface` aggregates them into its plugin compartment
 * and reconfigures whenever `revision` changes.
 *
 * Factories run per surface with that surface's context, and their return
 * values are expected to be CodeMirror `Extension`s built ONLY from the
 * host modules (`api.editor.cm` / `runtime-exports.ts`) — a factory that
 * throws is skipped and logged, it never breaks the editor.
 */
@Injectable({ providedIn: 'root' })
export class EditorExtensionRegistry {
  private readonly log = inject(LogService);
  private readonly entries = signal<readonly RegisteredExtension[]>([]);
  private readonly counter = signal(0);

  /** Changes on every registration/unregistration — surfaces watch this. */
  readonly revision = this.counter.asReadonly();

  register(
    owner: string,
    slot: EditorExtensionSlot,
    factory: (context: EditorSurfaceContext) => unknown,
  ): Unsubscribe {
    const entry: RegisteredExtension = { owner, slot, factory };
    this.entries.update((list) => [...list, entry]);
    this.counter.update((n) => n + 1);
    return () => {
      this.entries.update((list) => list.filter((e) => e !== entry));
      this.counter.update((n) => n + 1);
    };
  }

  /** Evaluates every matching factory for one surface. Order = registration. */
  extensionsFor(slot: 'document' | 'composer', context: EditorSurfaceContext): unknown[] {
    const out: unknown[] = [];
    for (const entry of this.entries()) {
      if (entry.slot !== slot && entry.slot !== 'both') {
        continue;
      }
      try {
        out.push(entry.factory(context));
      } catch (error) {
        this.log.record('error', `plugin "${entry.owner}" extension factory failed: ${String(error)}`);
      }
    }
    return out;
  }

  /** Derived: does any extension match this slot? (Surfaces can skip work.) */
  readonly hasAny = computed(() => this.entries().length > 0);
}
