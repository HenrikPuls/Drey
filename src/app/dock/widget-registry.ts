import { Type } from '@angular/core';
import type { WidgetCapability } from '../widgets';
import { TemplatesPanel } from '../templates';
import { TasksPanel } from '../tasks';
import type { DockSide } from './dock.service';
import { AssistantPanel } from './panels/assistant-panel';
import { CalendarPanel } from './panels/calendar-panel';
import { EntryPanel } from './panels/entry-panel';
import { FilesPanel } from './panels/files-panel';
import { SearchPanelHost } from './panels/search-panel-host';
import { WindowsPanel } from './panels/windows-panel';

/** A widget id. Was the closed `PanelId` union; now the registry is the source of truth. */
export type WidgetId = string;

/**
 * One dockable widget. The registry (`WIDGETS`) is the single source of
 * truth the dock, the `PanelFrame` header and the View menu all read from,
 * so adding another widget later is one array entry -- no union to widen,
 * no `Record<PanelId, …>` maps to keep in sync (ADR-0034).
 */
export interface WidgetDescriptor {
  /** Stored in `DockState` and (milestone 18) `AppConfig.widgets`. */
  id: WidgetId;
  /** Mono-uppercase header label. */
  title: string;
  /** Body component, rendered via `*ngComponentOutlet`. */
  component: Type<unknown>;
  /** Where it lives on a fresh layout / after `View → Reset layout`. */
  defaultDock: DockSide;
  /** Expanded (`true`) or collapsed to its header (`false`) by default. */
  defaultOpen: boolean;
  /** `flex-grow` weight when expanded (ignored for a content-height widget). */
  defaultFlex: number;
  /** Sizes to its content instead of a flex share; draws no splitter (was `CONTENT_HEIGHT_PANELS`). */
  contentHeight?: boolean;
  /** Body fills the frame instead of scrolling (was `PanelFrame.flush`). */
  flush?: boolean;
  /** Can be hidden from the View menu / disabled in Settings. */
  removable: boolean;
  /** Read surfaces it declares (descriptive; see `WidgetCapability`). */
  capabilities: readonly WidgetCapability[];
}

/**
 * The built-in widgets, in per-dock default order. Values carried over
 * verbatim from the old `dock.service.ts` `defaultState()` +
 * `panel-registry.ts`.
 */
export const WIDGETS: readonly WidgetDescriptor[] = [
  {
    id: 'calendar',
    title: 'Calendar',
    component: CalendarPanel,
    defaultDock: 'left',
    defaultOpen: true,
    defaultFlex: 250,
    contentHeight: true,
    removable: true,
    capabilities: ['active-document'],
  },
  {
    id: 'files',
    title: 'Files',
    component: FilesPanel,
    defaultDock: 'left',
    defaultOpen: true,
    defaultFlex: 340,
    removable: true,
    capabilities: ['file-tree', 'active-document'],
  },
  {
    id: 'templates',
    title: 'Templates',
    component: TemplatesPanel,
    defaultDock: 'left',
    defaultOpen: false,
    defaultFlex: 200,
    removable: true,
    capabilities: ['active-document'],
  },
  {
    id: 'search',
    title: 'Search',
    component: SearchPanelHost,
    defaultDock: 'left',
    defaultOpen: false,
    defaultFlex: 220,
    removable: true,
    capabilities: ['tag-queries', 'search', 'active-document'],
  },
  {
    id: 'tasks',
    title: 'Tasks',
    component: TasksPanel,
    defaultDock: 'left',
    defaultOpen: false,
    defaultFlex: 220,
    // The filter row stays pinned; only the task list scrolls (no second
    // scrollbar on the panel body).
    flush: true,
    removable: true,
    capabilities: ['task-queries', 'active-document'],
  },
  {
    id: 'windows',
    title: 'Open windows',
    component: WindowsPanel,
    defaultDock: 'left',
    defaultOpen: true,
    defaultFlex: 150,
    removable: true,
    capabilities: ['active-document'],
  },
  {
    id: 'assistant',
    title: 'Assistant',
    component: AssistantPanel,
    defaultDock: 'right',
    defaultOpen: true,
    defaultFlex: 100,
    flush: true,
    removable: true,
    capabilities: ['active-document'],
  },
  {
    id: 'entry',
    title: 'Add entry',
    component: EntryPanel,
    defaultDock: 'bottom',
    defaultOpen: false,
    defaultFlex: 200,
    flush: true,
    removable: true,
    capabilities: ['active-document', 'tag-queries'],
  },
];

export const WIDGET_MAP: ReadonlyMap<WidgetId, WidgetDescriptor> = new Map(
  WIDGETS.map((w) => [w.id, w]),
);

/** Every registered widget id, in registry order. */
export const ALL_WIDGET_IDS: readonly WidgetId[] = WIDGETS.map((w) => w.id);
