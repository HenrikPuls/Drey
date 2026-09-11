import { Injectable, computed, signal } from '@angular/core';
import type {
  ContextMenuItem,
  MenuContribution,
  Unsubscribe,
} from '../../../shared/plugin-api/renderer';

export type ContributableMenu = MenuContribution['menu'];

interface RegisteredContribution {
  readonly owner: string;
  readonly items: readonly MenuContribution[];
}

/**
 * The titlebar-menu seam (ADR-0044 stage 2): plugins append rows to the
 * File / Edit / Selection / View menus. Rows render after the built-ins of
 * their menu, in registration order; a row either names a registered
 * command id or carries its own `run()`.
 */
@Injectable({ providedIn: 'root' })
export class MenuContributionsService {
  private readonly entries = signal<readonly RegisteredContribution[]>([]);

  /** Derived per-menu row list, flattened in registration order. */
  readonly itemsForFile = computed(() => this.itemsFor('file'));
  readonly itemsForEdit = computed(() => this.itemsFor('edit'));
  readonly itemsForSelection = computed(() => this.itemsFor('selection'));
  readonly itemsForView = computed(() => this.itemsFor('view'));
  /** The editor meta-bar `⋯` menu's plugin rows (the manual Actions' home). */
  readonly itemsForEditorMore = computed(() => this.itemsFor('editor-more'));

  register(owner: string, items: readonly MenuContribution[]): Unsubscribe {
    const entry: RegisteredContribution = { owner, items };
    this.entries.update((list) => [...list, entry]);
    return () => {
      this.entries.update((list) => list.filter((e) => e !== entry));
    };
  }

  /** Derived per-menu row list, flattened in registration order. */
  itemsFor(menu: ContributableMenu): readonly MenuContribution[] {
    return this.entries().flatMap((e) => e.items.filter((item) => item.menu === menu));
  }
}

/**
 * The editor context-menu seam (ADR-0044 stage 2): plugins append items to
 * the renderer-owned editor context menu (ADR-0030). Re-evaluated on every
 * open via the callback form, so items can enable/disable dynamically.
 */
@Injectable({ providedIn: 'root' })
export class EditorContextMenuRegistry {
  private readonly providers = signal<readonly (() => readonly ContextMenuItem[])[]>([]);

  /**
   * Deliberately a METHOD, not a computed: the callback form is meant to be
   * re-evaluated on every menu open (the consumer's own computed, keyed on
   * its open-state signal, calls this fresh). A cached derivation would
   * freeze the items until a provider (un)registers.
   */
  items(): readonly ContextMenuItem[] {
    return this.providers().flatMap((provide) => provide());
  }

  register(items: () => readonly ContextMenuItem[]): Unsubscribe {
    this.providers.update((list) => [...list, items]);
    return () => {
      this.providers.update((list) => list.filter((p) => p !== items));
    };
  }
}
