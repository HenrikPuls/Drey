import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { endDragChrome, moveDragChrome, startDragChrome } from '../dnd';
import { PaneService } from '../panes/pane.service';
import { LayoutGestureService } from '../services/layout-gesture.service';
import { SettingsService } from '../services/settings.service';
import { WidgetId, type WidgetDescriptor } from './widget-registry';
import { WidgetRegistryService } from './widget-registry.service';

/**
 * A dockable widget id. Kept as an alias for continuity -- the registry
 * (`widget-registry.ts`) is now the source of truth, so this is an open
 * string rather than the old closed union.
 *
 * @deprecated use `WidgetId`
 */
export type PanelId = WidgetId;

/**
 * The three docks. `left` / `right` are vertical columns beside the
 * editor; `bottom` is a band under it (the old fixed "Add entry" strip,
 * now a real dock). Panels stack vertically in every dock -- the bottom
 * band just happens to be wide and short.
 */
export type DockSide = 'left' | 'right' | 'bottom';

/**
 * What a dock-header drag is carrying: a widget id (panel drag, ADR-0019)
 * or a docked editor pane (ADR-0038's editor band drag).
 */
export type DockDragPayload = WidgetId | { readonly kind: 'editor'; readonly paneId: string };

/** The docks, plus the centre column -- an editor drag's "back to the editor area" target. */
export type DockDropTarget = DockSide | 'center';

const DOCK_SIDES: readonly DockSide[] = ['left', 'right', 'bottom'];

/** Persisted layout state (DESIGN.md "Datenmodell", minus the transient drag fields). */
interface DockState {
  dock: Record<DockSide, WidgetId[]>;
  /** `flex-grow` weight per open panel. */
  flexes: Record<WidgetId, number>;
  /** `true` = expanded, `false` = collapsed to its header. */
  open: Record<WidgetId, boolean>;
  /** Widgets removed from every dock via the View menu (still enabled, no header shown). */
  hidden: WidgetId[];
  leftW: number;
  rightW: number;
  /** Height of the bottom dock band. */
  bottomH: number;
}

const WIDTH = { min: 180, max: 560 } as const;
const HEIGHT = { min: 140, max: 680 } as const;
const DEFAULT_LEFT_W = 248;
const DEFAULT_RIGHT_W = 340;
const DEFAULT_BOTTOM_H = 280;

/** Shallow, order-sensitive array equality. */
function sameList(a: readonly WidgetId[], b: readonly WidgetId[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Owns the dock layout: which widget sits in which dock and in what order,
 * each one's height weight and collapse state, which are hidden, and the
 * two dock widths. Persisted synchronously to `localStorage` (per-machine
 * window chrome, not note data -- same reasoning as `LayoutService`), read
 * back before first paint so the layout doesn't jump.
 *
 * It also runs the live drag / splitter / dock-edge resize gestures. Those
 * need `window`-level move/up listeners (the pointer leaves the 7px strip
 * or the header reorders under it mid-drag) and element rects, so the
 * mechanics live here rather than in the components -- `Dock` / `PanelFrame`
 * just register their host elements and call `startPanelDrag` etc. Ported
 * from the design prototype (`handoff/Drey App v3.dc.html`).
 */
@Injectable({ providedIn: 'root' })
export class DockService {
  private static readonly KEY = 'drey.dock';
  private static readonly MIN_PANEL_PX = 40;
  /** Extra slack, in px, when deciding a pointer is "over" a dock. */
  private static readonly DOCK_TOLERANCE = 12;

  private readonly settings = inject(SettingsService);
  private readonly layoutGesture = inject(LayoutGestureService);
  private readonly registry = inject(WidgetRegistryService);
  /** Owns the editor band's side + height (ADR-0038) -- a read-only consumer here. */
  private readonly panes = inject(PaneService);
  private readonly state = signal<DockState>(this.read());

  /** What is being dragged by a dock header: a widget or an editor pane, else null. */
  readonly dragging = signal<DockDragPayload | null>(null);
  /** True while any panel is being dragged -- docks use it to show themselves as drop targets. */
  readonly dragActive = computed(() => this.dragging() !== null);
  /** Where the drag would drop it right now (`'center'` only for editor drags). */
  readonly dropDock = signal<DockDropTarget | null>(null);
  readonly dropIndex = signal<number | null>(null);
  /** True while a splitter or dock-edge is being dragged. */
  readonly resizing = signal(false);

  /** Host elements, registered by the components, for hit-testing during a drag. */
  private readonly panelEls = new Map<WidgetId, HTMLElement>();
  private readonly dockEls = new Map<DockSide, HTMLElement>();

  constructor() {
    if (typeof window !== 'undefined') {
      // A pointerup lost outside the window (Alt-Tab mid-drag, a devtools
      // pause) would otherwise leave `document.body` unselectable with the
      // grab cursor stuck -- and the drag listeners attached. Abort on blur.
      window.addEventListener('blur', () => {
        if (this.headerPress) {
          window.removeEventListener('mousemove', this.onHeaderPressMove);
          window.removeEventListener('mouseup', this.onHeaderPressUp);
          this.headerPress = null;
        }
        if (this.dragging() !== null || this.resizing()) {
          this.onDragEnd();
          this.resizing.set(false);
          this.setGlobalGesture(null);
        }
      });
    }

    // Mirror "a dock resize / panel drag is in flight" into the shared
    // layout-gesture flag so an in-editor browser view hides for it
    // (ADR-0042).
    effect(() => this.layoutGesture.set('dock', this.resizing() || this.dragActive()));

    // Settings -> Widgets: fold the "disabled" set into the layout whenever
    // it changes (persisted config, so this fires on Save and on load).
    //
    // Both effects write `state` (via `patch`, whose `persist` also reads
    // it), so each body runs untracked: only the inputs named here may
    // re-trigger it. Tracking `state` made the two effects re-fire each
    // other forever (see `absorbRegistry`).
    effect(() => {
      const disabled = this.settings.widgetsDisabled();
      untracked(() => this.reconcileEnabled(disabled));
    });

    // The registry is runtime (ADR-0044): a plugin widget could register
    // after this service was first injected. Whatever the construction
    // order, converge: every registered widget gets a dock slot (or keeps
    // its hidden one) and default flex/open values.
    effect(() => {
      const widgets = this.registry.widgets();
      const disabled = this.settings.widgetsDisabled();
      untracked(() => this.absorbRegistry(widgets, disabled));
    });
  }

  /**
   * Adds dock-list slots + default flex/open for widgets the state doesn't
   * know yet. A widget disabled in Settings gets its defaults but no slot --
   * `reconcileEnabled` strips those, so placing one here would undo it and
   * the two would fight indefinitely.
   */
  private absorbRegistry(widgets: readonly WidgetDescriptor[], disabled: ReadonlySet<string>): void {
    this.patch((s) => {
      const dock = {
        left: [...s.dock.left],
        right: [...s.dock.right],
        bottom: [...s.dock.bottom],
      };
      const flexes = { ...s.flexes };
      const open = { ...s.open };
      let changed = false;
      for (const w of widgets) {
        const placed =
          dock.left.includes(w.id) || dock.right.includes(w.id) || dock.bottom.includes(w.id) ||
          s.hidden.includes(w.id);
        if (flexes[w.id] === undefined) {
          flexes[w.id] = w.defaultFlex;
          changed = true;
        }
        if (open[w.id] === undefined) {
          open[w.id] = w.defaultOpen;
          changed = true;
        }
        if (!placed && !disabled.has(w.id)) {
          dock[w.defaultDock].splice(this.orderedInsertIndex(w.defaultDock, w.id, dock[w.defaultDock]), 0, w.id);
          changed = true;
        }
      }
      return changed ? { ...s, dock, flexes, open } : s;
    });
  }

  readonly leftIds = computed(() => this.state().dock.left);  readonly rightIds = computed(() => this.state().dock.right);
  readonly bottomIds = computed(() => this.state().dock.bottom);
  readonly hasLeft = computed(() => this.state().dock.left.length > 0);
  readonly hasRight = computed(() => this.state().dock.right.length > 0);
  readonly hasBottom = computed(() => this.state().dock.bottom.length > 0);

  idsFor(side: DockSide): WidgetId[] {
    return this.state().dock[side];
  }

  sideOf(id: WidgetId): DockSide | null {
    const { dock } = this.state();
    return DOCK_SIDES.find((side) => dock[side].includes(id)) ?? null;
  }

  collapsed(id: WidgetId): boolean {
    return !this.state().open[id];
  }

  /** True while a widget is hidden from every dock (View menu deselect). */
  isHidden(id: WidgetId): boolean {
    return this.state().hidden.includes(id);
  }

  /** True for a panel sized to its content rather than a `flex-grow` share. */
  contentHeight(id: WidgetId): boolean {
    return this.registry.descriptor(id)?.contentHeight ?? false;
  }

  /**
   * True when a dock has no expanded panel -- every panel is collapsed to
   * its header, or the dock is empty. The bottom dock then shrinks to its
   * stacked headers and its resize splitter is hidden (nothing to size).
   */
  allCollapsed(side: DockSide): boolean {
    const ids = this.state().dock[side];
    return ids.every((id) => !this.state().open[id]);
  }

  flexOf(id: WidgetId): number {
    return this.state().flexes[id];
  }

  /** Column width for a side dock (not meaningful for `bottom` -- use `dockHeight`). */
  dockWidth(side: DockSide): number {
    return side === 'left' ? this.state().leftW : this.state().rightW;
  }

  /** Band height for the bottom dock. */
  dockHeight(): number {
    return this.state().bottomH;
  }

  toggleCollapse(id: WidgetId): void {
    this.patch((s) => ({ ...s, open: { ...s.open, [id]: !s.open[id] } }));
  }

  /**
   * View menu deselect: pull `id` out of every dock into `hidden` (no
   * header shown). Its flex / collapse state is kept for when it returns.
   */
  hide(id: WidgetId): void {
    this.patch((s) => {
      if (s.hidden.includes(id)) {
        return s;
      }
      return {
        ...s,
        dock: {
          left: s.dock.left.filter((x) => x !== id),
          right: s.dock.right.filter((x) => x !== id),
          bottom: s.dock.bottom.filter((x) => x !== id),
        },
        hidden: [...s.hidden, id],
      };
    });
  }

  /**
   * View menu re-select: put `id` back into its descriptor's default dock,
   * at the slot that keeps the registry order, expanded.
   */
  show(id: WidgetId): void {
    this.patch((s) => {
      if (!s.hidden.includes(id)) {
        return s;
      }
      return {
        ...s,
        dock: this.withInserted(s.dock, id),
        hidden: s.hidden.filter((x) => x !== id),
        open: { ...s.open, [id]: true },
      };
    });
  }

  /** Expand a panel and make sure it is docked (also un-hides it). */
  openAndExpand(id: WidgetId): void {
    this.patch((s) => {
      const hidden = s.hidden.filter((x) => x !== id);
      const wasHidden = hidden.length !== s.hidden.length;
      if (!wasHidden && s.open[id] && DOCK_SIDES.some((side) => s.dock[side].includes(id))) {
        return s;
      }
      const docked = DOCK_SIDES.some((side) => s.dock[side].includes(id));
      return {
        ...s,
        dock: docked ? s.dock : this.withInserted(s.dock, id),
        hidden,
        open: { ...s.open, [id]: true },
      };
    });
  }

  /** A copy of `dock` with `id` inserted into its default dock at the ordered slot. */
  private withInserted(dock: Record<DockSide, WidgetId[]>, id: WidgetId): Record<DockSide, WidgetId[]> {
    const side = this.registry.descriptor(id)?.defaultDock ?? 'left';
    const lists: Record<DockSide, WidgetId[]> = {
      left: [...dock.left],
      right: [...dock.right],
      bottom: [...dock.bottom],
    };
    lists[side].splice(this.orderedInsertIndex(side, id, lists[side]), 0, id);
    return lists;
  }

  private defaultState(): DockState {
    const dock: Record<DockSide, WidgetId[]> = { left: [], right: [], bottom: [] };
    const flexes: Record<WidgetId, number> = {};
    const open: Record<WidgetId, boolean> = {};
    for (const w of this.registry.widgets()) {
      dock[w.defaultDock].push(w.id);
      flexes[w.id] = w.defaultFlex;
      open[w.id] = w.defaultOpen;
    }
    return {
      dock,
      flexes,
      open,
      hidden: [],
      leftW: DEFAULT_LEFT_W,
      rightW: DEFAULT_RIGHT_W,
      bottomH: DEFAULT_BOTTOM_H,
    };
  }

  /**
   * Where `id` slots into `current` (a live dock list) to keep the registry's
   * default order among the widgets already present -- used when a widget is
   * un-hidden or re-homed.
   */
  private orderedInsertIndex(side: DockSide, id: WidgetId, current: readonly WidgetId[]): number {
    const order = this.registry
      .widgets()
      .filter((w) => w.defaultDock === side)
      .map((w) => w.id);
    const target = order.indexOf(id);
    for (let i = 0; i < current.length; i++) {
      if (order.indexOf(current[i]) > target) {
        return i;
      }
    }
    return current.length;
  }

  setDockWidth(side: DockSide, px: number): void {
    const clamped = Math.max(WIDTH.min, Math.min(WIDTH.max, Math.round(px)));
    this.patch((s) => (side === 'left' ? { ...s, leftW: clamped } : { ...s, rightW: clamped }));
  }

  setBottomHeight(px: number): void {
    const clamped = Math.max(HEIGHT.min, Math.min(HEIGHT.max, Math.round(px)));
    this.patch((s) => ({ ...s, bottomH: clamped }));
  }

  /** View -> "Reset layout": everything back to the defaults. */
  reset(): void {
    this.state.set(this.defaultState());
    this.persist();
  }

  /**
   * Settings -> Widgets: drop every disabled widget from the docks and from
   * `hidden`, and re-home any widget that has been re-enabled and is now
   * nowhere. Driven by an effect on `SettingsService.widgetsDisabled`
   * (persisted config -> fires on Save / on load); exposed for tests.
   */
  reconcileEnabled(disabled: ReadonlySet<string>): void {
    const s = this.state();
    const lists: Record<DockSide, WidgetId[]> = {
      left: s.dock.left.filter((id) => !disabled.has(id)),
      right: s.dock.right.filter((id) => !disabled.has(id)),
      bottom: s.dock.bottom.filter((id) => !disabled.has(id)),
    };
    const hidden = s.hidden.filter((id) => !disabled.has(id));
    const placed = new Set<WidgetId>([...lists.left, ...lists.right, ...lists.bottom, ...hidden]);
    for (const w of this.registry.widgets()) {
      if (!disabled.has(w.id) && !placed.has(w.id)) {
        lists[w.defaultDock].splice(
          this.orderedInsertIndex(w.defaultDock, w.id, lists[w.defaultDock]),
          0,
          w.id,
        );
      }
    }
    const same =
      sameList(lists.left, s.dock.left) &&
      sameList(lists.right, s.dock.right) &&
      sameList(lists.bottom, s.dock.bottom) &&
      sameList(hidden, s.hidden);
    if (!same) {
      this.patch((cur) => ({ ...cur, dock: lists, hidden }));
    }
  }

  /** The first open panel after `id` in the same dock, or null -- what a splitter connects to. */
  nextOpenId(id: WidgetId): WidgetId | null {
    const side = this.sideOf(id);
    if (!side) {
      return null;
    }
    const ids = this.state().dock[side];
    for (let i = ids.indexOf(id) + 1; i < ids.length; i++) {
      if (this.state().open[ids[i]]) {
        return ids[i];
      }
    }
    return null;
  }

  // ---- element registration (called from Dock / PanelFrame) ----

  registerPanelEl(id: WidgetId, el: HTMLElement): void {
    this.panelEls.set(id, el);
  }

  unregisterPanelEl(id: WidgetId, el: HTMLElement): void {
    if (this.panelEls.get(id) === el) {
      this.panelEls.delete(id);
    }
  }

  registerDockEl(side: DockSide, el: HTMLElement): void {
    this.dockEls.set(side, el);
  }

  unregisterDockEl(side: DockSide, el: HTMLElement): void {
    if (this.dockEls.get(side) === el) {
      this.dockEls.delete(side);
    }
  }

  // ---- panel header press: a click toggles collapse, a drag moves ----

  /** In-flight header press, before it is promoted to a real drag. */
  private headerPress: {
    payload: DockDragPayload;
    title: string;
    startX: number;
    startY: number;
    promoted: boolean;
    /** Editor drags focus their pane on a plain click; widget drags collapse. */
    click: (payload: DockDragPayload) => void;
  } | null = null;
  private static readonly DRAG_THRESHOLD_PX = 4;

  /**
   * Mousedown on a panel header. A release before the pointer moves
   * `DRAG_THRESHOLD_PX` is treated as a click -> toggle collapse; moving
   * past it promotes the gesture to a panel drag between docks.
   */
  beginHeaderPress(id: WidgetId, title: string, event: MouseEvent): void {
    this.beginPress(id, title, event, () => this.toggleCollapse(id));
  }

  /**
   * Mousedown on the editor band's header (ADR-0038). Same press-then-
   * promote recipe; a plain click just focuses the pane (there is no
   * collapse), a drag moves the whole editor group to another dock or back
   * to the centre.
   */
  beginEditorBandPress(paneId: string, title: string, event: MouseEvent): void {
    this.beginPress(
      { kind: 'editor', paneId },
      title,
      event,
      (payload) => {
        if (payload !== null && typeof payload === 'object') {
          this.panes.focus(payload.paneId);
        }
      },
    );
  }

  private beginPress(
    payload: DockDragPayload,
    title: string,
    event: MouseEvent,
    click: (payload: DockDragPayload) => void,
  ): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    this.headerPress = { payload, title, startX: event.clientX, startY: event.clientY, promoted: false, click };
    window.addEventListener('mousemove', this.onHeaderPressMove);
    window.addEventListener('mouseup', this.onHeaderPressUp);
  }

  private readonly onHeaderPressMove = (event: MouseEvent): void => {
    const press = this.headerPress;
    if (!press || press.promoted) {
      return;
    }
    const moved = Math.hypot(event.clientX - press.startX, event.clientY - press.startY);
    if (moved < DockService.DRAG_THRESHOLD_PX) {
      return;
    }
    // Promote to a drag: hand off to the move/end listeners.
    press.promoted = true;
    window.removeEventListener('mousemove', this.onHeaderPressMove);
    this.dragging.set(press.payload);
    this.dropDock.set(null);
    this.dropIndex.set(null);
    // Shared with the tab drag (ADR-0039): a full-viewport overlay that
    // owns the cursor and blocks hover/selection underneath, plus the
    // `.dock-drag-ghost` chip and the `data-drey-gesture` watchdog marker.
    startDragChrome({ gesture: 'dock', ghostClass: 'dock-drag-ghost', ghostHtml: press.title });
    window.addEventListener('mousemove', this.onDragMove);
    window.addEventListener('mouseup', this.onDragEnd);
    this.onDragMove(event);
  };

  private readonly onHeaderPressUp = (): void => {
    window.removeEventListener('mousemove', this.onHeaderPressMove);
    window.removeEventListener('mouseup', this.onHeaderPressUp);
    const press = this.headerPress;
    this.headerPress = null;
    if (press && !press.promoted) {
      press.click(press.payload);
    }
  };

  private readonly onDragMove = (event: MouseEvent): void => {
    moveDragChrome(event.clientX, event.clientY);
    const payload = this.dragging();
    if (payload !== null && typeof payload === 'object') {
      this.onEditorDragMove(payload, event);
      return;
    }

    const left = this.dockEls.get('left')?.getBoundingClientRect();
    const right = this.dockEls.get('right')?.getBoundingClientRect();
    const bottom = this.dockEls.get('bottom')?.getBoundingClientRect();
    const t = DockService.DOCK_TOLERANCE;

    // A side dock wins while the pointer is horizontally over it; anything
    // in the lower band (past the bottom dock's top edge) that is not over a
    // side dock drops into the bottom dock -- same "whole region" leniency
    // the side docks already get, so every panel can reach every dock.
    const overLeft = !!left && event.clientX <= left.right + t;
    const overRight = !!right && event.clientX >= right.left - t;
    const inBottomBand = !!bottom && event.clientY >= bottom.top - t;

    let target: DockSide;
    if (inBottomBand && !overLeft && !overRight) {
      target = 'bottom';
    } else if (overLeft) {
      target = 'left';
    } else if (overRight) {
      target = 'right';
    } else if (inBottomBand) {
      target = 'bottom';
    } else {
      target = event.clientX < window.innerWidth / 2 ? 'left' : 'right';
    }

    const ids = this.state().dock[target];
    let index = ids.length;
    for (let i = 0; i < ids.length; i++) {
      const rect = this.panelEls.get(ids[i])?.getBoundingClientRect();
      if (rect && event.clientY < rect.top + rect.height / 2) {
        index = i;
        break;
      }
    }

    if (this.dropDock() !== target) {
      this.dropDock.set(target);
    }
    if (this.dropIndex() !== index) {
      this.dropIndex.set(index);
    }
  };

  /**
   * The editor band's drag (ADR-0038): the centre column is a target --
   * "not over any dock" is exactly the centre -- and a drag never shows a
   * widget drop-line (`dropIndex` stays null).
   */
  private readonly onEditorDragMove = (
    payload: { readonly kind: 'editor'; readonly paneId: string },
    event: MouseEvent,
  ): void => {
    const left = this.dockEls.get('left')?.getBoundingClientRect();
    const right = this.dockEls.get('right')?.getBoundingClientRect();
    const bottom = this.dockEls.get('bottom')?.getBoundingClientRect();
    const t = DockService.DOCK_TOLERANCE;

    const overLeft = !!left && event.clientX <= left.right + t;
    const overRight = !!right && event.clientX >= right.left - t;
    const inBottomBand = !!bottom && event.clientY >= bottom.top - t;

    let target: DockDropTarget;
    if (overLeft) {
      target = 'left';
    } else if (overRight) {
      target = 'right';
    } else if (inBottomBand) {
      target = 'bottom';
    } else {
      target = 'center';
    }

    if (this.dropDock() !== target) {
      this.dropDock.set(target);
    }
    if (this.dropIndex() !== null) {
      this.dropIndex.set(null);
    }
  };

  private readonly onDragEnd = (): void => {
    window.removeEventListener('mousemove', this.onDragMove);
    window.removeEventListener('mouseup', this.onDragEnd);
    endDragChrome();

    const payload = this.dragging();
    const target = this.dropDock();
    const index = this.dropIndex();
    this.dragging.set(null);
    this.dropDock.set(null);
    this.dropIndex.set(null);

    if (payload !== null && typeof payload === 'object') {
      // The editor band's drag: a dock takes the pane (an occupied dock's
      // occupant goes back to the centre, inside PaneService); the centre
      // takes it back into the split tree.
      if (target !== null) {
        if (target === 'center') {
          this.panes.reattachToCenter(payload.paneId);
        } else {
          this.panes.detachToDock(payload.paneId, target);
        }
      }
      return;
    }

    if (!payload || !target || target === 'center' || index === null) {
      return; // 'center' is never a widget target -- widget drags keep the screen-half fallback
    }
    this.move(payload, target, index);
  };

  /** Move `id` to `dock` so it lands at visual slot `index` (drop-line position). */
  move(id: WidgetId, dock: DockSide, index: number): void {
    this.patch((s) => {
      const from = s.dock[dock].slice(0, index).filter((x) => x !== id).length;
      const lists: Record<DockSide, WidgetId[]> = {
        left: s.dock.left.filter((x) => x !== id),
        right: s.dock.right.filter((x) => x !== id),
        bottom: s.dock.bottom.filter((x) => x !== id),
      };
      lists[dock].splice(from, 0, id);
      return { ...s, dock: lists, hidden: s.hidden.filter((x) => x !== id) };
    });
  }

  // ---- splitter (height redistribution between two neighbours) ----

  startSplit(aId: WidgetId, bId: WidgetId, event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const a = this.panelEls.get(aId);
    const b = this.panelEls.get(bId);
    if (!a || !b) {
      return;
    }
    const aH = a.offsetHeight;
    const total = aH + b.offsetHeight;
    const startY = event.clientY;
    const min = DockService.MIN_PANEL_PX;

    this.beginPointerGesture(event, 'row-resize', (ev) => {
      const na = Math.max(min, Math.min(total - min, aH + (ev.clientY - startY)));
      this.patch((s) => ({ ...s, flexes: { ...s.flexes, [aId]: na, [bId]: total - na } }));
    });
  }

  // ---- dock outer-edge resize ----

  startDockResize(side: DockSide, event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    if (side === 'bottom') {
      // The band grows as the pointer moves up: measure from its own
      // bottom edge so a status bar / other chrome below it doesn't skew
      // the value.
      const anchor =
        this.dockEls.get('bottom')?.getBoundingClientRect().bottom ?? window.innerHeight;
      this.beginPointerGesture(event, 'row-resize', (ev) => {
        this.setBottomHeight(anchor - ev.clientY);
      });
      return;
    }
    this.beginPointerGesture(event, 'col-resize', (ev) => {
      this.setDockWidth(side, side === 'left' ? ev.clientX : window.innerWidth - ev.clientX);
    });
  }

  /**
   * The editor band's splitter (ADR-0038): grows the band as the pointer
   * moves up -- the widget list below just flexes. Delta-based (like
   * `startSplit`): the band's top edge is fixed, so only the pointer's
   * travel matters. Height state lives in `PaneService`.
   */
  startEditorBandResize(side: DockSide, event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const band = (event.target as HTMLElement).previousElementSibling as HTMLElement | null;
    if (!band) {
      return;
    }
    const startY = event.clientY;
    const startHeight = band.getBoundingClientRect().height;
    this.beginPointerGesture(event, 'row-resize', (ev) => {
      this.panes.setBandHeight(side, startHeight + (startY - ev.clientY));
    });
  }

  private beginPointerGesture(
    event: PointerEvent,
    cursor: string,
    onMove: (ev: PointerEvent) => void,
  ): void {
    const el = event.target as HTMLElement;
    el.setPointerCapture?.(event.pointerId);
    this.resizing.set(true);
    this.setGlobalGesture(cursor);
    const move = (ev: PointerEvent): void => onMove(ev);
    const up = (): void => {
      el.releasePointerCapture?.(event.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      this.resizing.set(false);
      this.setGlobalGesture(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  private setGlobalGesture(cursor: string | null): void {
    if (typeof document === 'undefined') {
      return;
    }
    document.body.style.cursor = cursor ?? '';
    document.body.style.userSelect = cursor ? 'none' : '';
    // A marker the input-recovery watchdog reads: `user-select:none` on
    // <body> is only legitimate while this is set.
    if (cursor) {
      document.body.setAttribute('data-drey-gesture', 'dock');
    } else {
      document.body.removeAttribute('data-drey-gesture');
    }
  }

  private patch(fn: (s: DockState) => DockState): void {
    this.state.update(fn);
    this.persist();
  }

  private persist(): void {
    try {
      const { dock, flexes, open, hidden, leftW, rightW, bottomH } = this.state();
      localStorage.setItem(
        DockService.KEY,
        JSON.stringify({ dock, flexes, open, hidden, leftW, rightW, bottomH }),
      );
    } catch {
      // Private-mode / storage-disabled: a non-persisted session is fine.
    }
  }

  private read(): DockState {
    const base = this.defaultState();
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(DockService.KEY);
    } catch {
      return base;
    }
    if (!raw) {
      return base;
    }
    try {
      const saved = JSON.parse(raw) as Partial<DockState>;
      return this.merge(base, saved);
    } catch {
      return base;
    }
  }

  /** Fold a stored blob onto the defaults, dropping anything unrecognised. */
  private merge(base: DockState, saved: Partial<DockState>): DockState {
    const known = new Set<WidgetId>(this.registry.allWidgetIds());
    const clean = (list: unknown): WidgetId[] =>
      Array.isArray(list) ? list.filter((x): x is WidgetId => known.has(x as WidgetId)) : [];

    const left = clean(saved.dock?.left);
    const right = clean(saved.dock?.right);
    const bottom = clean(saved.dock?.bottom);
    const hidden = clean(saved.hidden);
    const lists: Record<DockSide, WidgetId[]> = { left, right, bottom };
    const placed = new Set<WidgetId>([...left, ...right, ...bottom, ...hidden]);
    // Any widget missing from the stored blob (e.g. one added by an app
    // update) goes back to its descriptor's default dock, in order.
    for (const w of this.registry.widgets()) {
      if (!placed.has(w.id)) {
        lists[w.defaultDock].splice(this.orderedInsertIndex(w.defaultDock, w.id, lists[w.defaultDock]), 0, w.id);
      }
    }

    const num = (v: unknown, fallback: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? v : fallback;

    return {
      dock: lists,
      flexes: Object.fromEntries(
        this.registry.allWidgetIds().map((id) => [id, num(saved.flexes?.[id], base.flexes[id])]),
      ) as Record<WidgetId, number>,
      open: Object.fromEntries(
        this.registry.allWidgetIds().map((id) => [
          id,
          typeof saved.open?.[id] === 'boolean' ? saved.open[id] : base.open[id],
        ]),
      ) as Record<WidgetId, boolean>,
      hidden,
      leftW: Math.max(WIDTH.min, Math.min(WIDTH.max, num(saved.leftW, base.leftW))),
      rightW: Math.max(WIDTH.min, Math.min(WIDTH.max, num(saved.rightW, base.rightW))),
      bottomH: Math.max(HEIGHT.min, Math.min(HEIGHT.max, num(saved.bottomH, base.bottomH))),
    };
  }
}
