import { Type } from '@angular/core';
import type { IconName } from '../icons/icon';
import type { WidgetCapability } from '../widgets';
import type { DockSide } from './dock.service';
import { CalendarPanel } from './panels/calendar-panel';
import { FilesPanel } from './panels/files-panel';
import { WindowsPanel } from './panels/windows-panel';

/** A widget id. Was the closed `PanelId` union; now the registry is the source of truth. */
export type WidgetId = string;

/**
 * What a header status callback may read. Carried as a parameter (not a
 * service injection) so the registry does not need `DockService` — which
 * needs the registry.
 */
export interface WidgetStatusContext {
  /** True while the panel is closed -- only its strip icon shows. */
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
  /** Header label (sentence case). */
  title: string;
  /**
   * Its glyph in the dock's icon strip. Unset only for a plugin widget that
   * names none -- the strip then shows the title's first letter.
   */
  icon?: IconName;
  /**
   * Body component, rendered via `*ngComponentOutlet`. Unset for a
   * plugin-registered widget — `Dock` renders `PluginWidgetHost` for those.
   */
  component?: Type<unknown>;
  /** Where it lives on a fresh layout / after `View → Reset layout`. */
  defaultDock: DockSide;
  /** Open (`true`) or closed to its strip icon (`false`) by default. */
  defaultOpen: boolean;
  /** `flex-grow` weight when expanded (ignored for a content-height widget). */
  defaultFlex: number;
  /** Sizes to its content instead of a flex share; draws no splitter (was `CONTENT_HEIGHT_PANELS`). */
  contentHeight?: boolean;
  /** Body fills the frame instead of scrolling (was `PanelFrame.flush`). */
  flush?: boolean;
  /**
   * The panel's header content (its `appPanelHeaderActions` template) takes
   * the whole header row and the title + status are not shown -- the
   * calendar's month/year dropdown IS its heading.
   */
  headerReplacesTitle?: boolean;
  /** Can be disabled in Settings. */
  removable: boolean;
  /** Read surfaces it declares (descriptive; see `WidgetCapability`). */
  capabilities: readonly WidgetCapability[];
  /** Header status value (right-aligned, dimmed); recomputed on change detection. */
  status?(context: WidgetStatusContext): string | null;
  /**
   * Builds the panel's own control row into the shared header (plugin
   * widgets only — core panels use the `[appPanelHeaderActions]` template).
   */
  headerActionsMount?(el: HTMLElement): () => void;
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
    icon: 'calendar',
    component: CalendarPanel,
    defaultDock: 'left',
    defaultOpen: true,
    defaultFlex: 250,
    contentHeight: true,
    headerReplacesTitle: true,
    removable: true,
    capabilities: ['active-document'],
  },
  {
    id: 'files',
    title: 'Files',
    icon: 'folder',
    component: FilesPanel,
    defaultDock: 'left',
    defaultOpen: true,
    defaultFlex: 340,
    removable: true,
    capabilities: ['file-tree', 'active-document'],
  },
  // `tasks` and `search` were core widgets until the ADR-0044 conversions;
  // the Tasks and Tags plugins register them at bootstrap through the same
  // runtime registry, keeping the ids (and so every persisted layout). The
  // `assistant` widget (right dock, flush) joined them in stage 7.
  {
    id: 'windows',
    title: 'Open windows',
    icon: 'window',
    component: WindowsPanel,
    defaultDock: 'left',
    defaultOpen: true,
    defaultFlex: 150,
    removable: true,
    capabilities: ['active-document'],
  },
  // The `entry` widget ("Add entry", bottom dock) was removed in milestone
  // 43 (ADR-0057): capture is the `/` menu's Entry block now. A persisted
  // layout still naming the id is dropped by `DockService` on load.
];
