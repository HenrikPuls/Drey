import { Injectable, Signal, computed, inject, signal } from '@angular/core';
import { AssistantService } from '../assistant';
import { CalendarService } from '../calendar';
import { EntryDraftService } from '../entry';
import { EditorService } from '../services/editor.service';
import type { PluginWidgetContrib, Unsubscribe } from '../../../shared/plugin-api/renderer';
import { CORE_WIDGETS, type WidgetDescriptor, type WidgetId, type WidgetStatusContext } from './widget-registry';

/**
 * The runtime widget registry (ADR-0034 made data-driven, ADR-0044 makes it
 * runtime): `CORE_WIDGETS` registered here at construction -- with the
 * header-status callbacks attached, which read the feature services -- plus
 * whatever plugins contribute through `api.ui.registerWidget`.
 *
 * Everything is derived signals, so a registration that happens before the
 * first consumer reads it (the app initializer runs before any dock
 * component) is simply part of the list.
 */
@Injectable({ providedIn: 'root' })
export class WidgetRegistryService {
  private readonly pluginWidgets = signal<readonly WidgetDescriptor[]>([]);
  private readonly contribs = new Map<WidgetId, PluginWidgetContrib>();

  /**
   * Bumped whenever an event plugins react to lands (document changes,
   * vault pushes). A plugin's `status()` reads plain plugin state -- no
   * signal the shell could track -- so the dock reads this tick instead:
   * every bump re-renders the headers, re-evaluating every status callback
   * (core statuses re-read their services the same way).
   */
  private readonly statusTick = signal(0);
  readonly statusVersion = this.statusTick.asReadonly();
  bumpStatusTick(): void {
    this.statusTick.update((v) => v + 1);
  }

  /** All registerable widgets, core first, then plugin contributions in registration order. */
  readonly widgets: Signal<readonly WidgetDescriptor[]> = computed(() => [
    ...this.coreWidgets,
    ...this.pluginWidgets(),
  ]);
  readonly widgetMap: Signal<ReadonlyMap<WidgetId, WidgetDescriptor>> = computed(
    () => new Map(this.widgets().map((w) => [w.id, w])),
  );
  readonly allWidgetIds: Signal<readonly WidgetId[]> = computed(() =>
    this.widgets().map((w) => w.id),
  );

  private readonly coreWidgets: readonly WidgetDescriptor[];

  constructor() {
    // The header-status readers. This is the one place (post-conversion: a
    // shrinking place) that knows which feature service backs which core
    // widget; a converted plugin brings its own `status()` callback.
    const calendar = inject(CalendarService);
    const editor = inject(EditorService);
    const assistant = inject(AssistantService);
    const entryDraft = inject(EntryDraftService);

    const statusCallbacks: Record<WidgetId, (context: WidgetStatusContext) => string | null> = {
      calendar: ({ collapsed }) =>
        // The expanded calendar shows the month in its own header row, so
        // only surface it in the panel header while collapsed.
        collapsed
          ? `${String(calendar.viewMonth() + 1).padStart(2, '0')}/${calendar.viewYear()}`
          : null,
      windows: () => String(editor.openDocs().length),
      assistant: () => {
        const p = assistant.notePath();
        return p ? (p.split('/').pop() ?? null) : null;
      },
      entry: () => (entryDraft.hasContent() ? 'unsent draft' : null),
    };

    this.coreWidgets = CORE_WIDGETS.map((w) => {
      const status = statusCallbacks[w.id];
      return status === undefined ? w : { ...w, status };
    });
  }

  descriptor(id: WidgetId): WidgetDescriptor | undefined {
    return this.widgetMap().get(id);
  }

  /** The plugin contribution behind a plugin-registered widget id, if any. */
  contribFor(id: WidgetId): PluginWidgetContrib | undefined {
    return this.contribs.get(id);
  }

  isPlugin(id: WidgetId): boolean {
    return this.contribs.has(id);
  }

  /**
   * Registers a plugin widget. A core-widget id collision is refused (the
   * core wins; a plugin may not impersonate the shell) -- and a plugin
   * replacing a converted feature reuses that feature's id only after the
   * conversion removed it from `CORE_WIDGETS`.
   */
  registerPluginWidget(contrib: PluginWidgetContrib): Unsubscribe {
    const existing = this.widgetMap().get(contrib.id);
    if (existing !== undefined && !this.isPlugin(contrib.id)) {
      throw new Error(`widget id "${contrib.id}" collides with a core widget`);
    }
    if (this.isPlugin(contrib.id)) {
      throw new Error(`widget id "${contrib.id}" is already registered by a plugin`);
    }
    this.contribs.set(contrib.id, contrib);
    const { status } = contrib;
    this.pluginWidgets.update((list) => [
      ...list,
      {
        id: contrib.id,
        title: contrib.title,
        // `component` stays unset for plugin widgets: `Dock` renders
        // `PluginWidgetHost` for them (keeps this service free of
        // component imports).
        defaultDock: contrib.defaultDock,
        defaultOpen: contrib.defaultOpen,
        defaultFlex: contrib.defaultFlex,
        ...(contrib.contentHeight !== undefined ? { contentHeight: contrib.contentHeight } : {}),
        ...(contrib.flush !== undefined ? { flush: contrib.flush } : {}),
        removable: true,
        capabilities: [],
        ...(status !== undefined
          ? { status: (context: WidgetStatusContext) => status(context) }
          : {}),
        ...(contrib.headerActions !== undefined
          ? { headerActionsMount: (el: HTMLElement) => contrib.headerActions!(el) }
          : {}),
      },
    ]);
    return () => {
      this.contribs.delete(contrib.id);
      this.pluginWidgets.update((list) => list.filter((w) => w.id !== contrib.id));
    };
  }
}
