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
 * What a header status callback may read. Carried as a parameter (not a
 * service injection) so the registry does not need `DockService` — which
 * needs the registry.
 */
export interface WidgetStatusContext {
  /** True while the panel is collapsed to its 32px header. */
  readonly collapsed: boolean;
}

/**
 * One dockable widget. The runtime registry
 * (`WidgetRegistryService`) is the single source of truth the dock, the
 * `PanelFrame` header and the View menu all read from, so adding another
 * widget is one registration -- core widgets come from `CORE_WIDGETS`
 * below, plugin widgets from `api.ui.registerWidget` (ADR-0034, extended by
 * ADR-0044).
 */
export interface WidgetDescriptor {
  /** Stored in `DockState` and (milestone 18) `AppConfig.widgets`. */
  id: WidgetId;
  /** Mono-uppercase header label. */
  title: string;
  /**
   * Body component, rendered via `*ngComponentOutlet`. Unset for a
   * plugin-registered widget — `Dock` renders `PluginWidgetHost` for those.
   */
  component?: Type<unknown>;
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
  /** Header status value (right-aligned, dimmed); recomputed on change detection. */
  status?(context: WidgetStatusContext): string | null;
}

/**
 * The built-in core widgets, in per-dock default order (ADR-0044: the
 * features that are becoming plugins will leave this list as they
 * convert, registering through the same runtime registry instead).
 * Status callbacks are attached by `WidgetRegistryService`, which owns
 * the feature services they read.
 */
export const CORE_WIDGETS: readonly WidgetDescriptor[] = [
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
