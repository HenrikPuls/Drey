import { Injectable, signal } from '@angular/core';
import type { FindModeContrib, Unsubscribe } from '../../../shared/plugin-api/renderer';

/**
 * The find-mode registry (SDK 1.53): modes of a Find panel that plugins offer
 * through `ui.registerFindMode`. The base attaches no meaning to a mode; the
 * plugin that draws the panel reads the list. A taken id is refused.
 */
@Injectable({ providedIn: 'root' })
export class FindModeRegistry {
  private readonly modes = signal<readonly FindModeContrib[]>([]);
  private readonly listeners = new Set<() => void>();

  /** The modes by `order`, registration order within equal order. */
  list(): readonly FindModeContrib[] {
    return this.modes()
      .map((mode, index) => ({ mode, index }))
      .sort((a, b) => a.mode.order - b.mode.order || a.index - b.index)
      .map(({ mode }) => mode);
  }

  register(mode: FindModeContrib): Unsubscribe {
    if (this.modes().some((m) => m.id === mode.id)) {
      throw new Error(`find mode "${mode.id}" is already registered`);
    }
    this.modes.update((list) => [...list, mode]);
    this.fire();
    return () => {
      this.modes.update((list) => list.filter((m) => m !== mode));
      this.fire();
    };
  }

  onChange(listener: () => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private fire(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}
