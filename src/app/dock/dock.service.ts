import { Injectable, computed, signal } from '@angular/core';

/** The dockable panels. Order within a dock is the render order. */
export type PanelId = 'calendar' | 'files' | 'search' | 'windows' | 'assistant' | 'entry';

/**
 * The three docks. `left` / `right` are vertical columns beside the
 * editor; `bottom` is a band under it (the old fixed "Add entry" strip,
 * now a real dock). Panels stack vertically in every dock -- the bottom
 * band just happens to be wide and short.
 */
export type DockSide = 'left' | 'right' | 'bottom';

const DOCK_SIDES: readonly DockSide[] = ['left', 'right', 'bottom'];

/** Persisted layout state (DESIGN.md "Datenmodell", minus the transient drag fields). */
interface DockState {
  dock: Record<DockSide, PanelId[]>;
  /** `flex-grow` weight per open panel. */
  flexes: Record<PanelId, number>;
  /** `true` = expanded, `false` = collapsed to its header. */
  open: Record<PanelId, boolean>;
  leftW: number;
  rightW: number;
  /** Height of the bottom dock band. */
  bottomH: number;
}

const ALL_PANELS: readonly PanelId[] = [
  'calendar',
  'files',
  'search',
  'windows',
  'assistant',
  'entry',
];

/**
 * Panels that take exactly their content's height when expanded instead of
 * a `flex-grow` share of the dock. The calendar is a fixed grid -- letting
 * it stretch just adds dead space below the last week and flattens the day
 * cells. A splitter is not drawn on either side of one (you cannot resize
 * a content-sized panel).
 */
const CONTENT_HEIGHT_PANELS: ReadonlySet<PanelId> = new Set<PanelId>(['calendar']);

const WIDTH = { min: 180, max: 560 } as const;
const HEIGHT = { min: 140, max: 680 } as const;

function defaultState(): DockState {
  return {
    dock: {
      left: ['calendar', 'files', 'search', 'windows'],
      right: ['assistant'],
      bottom: ['entry'],
    },
    flexes: { calendar: 250, files: 340, search: 220, windows: 150, assistant: 100, entry: 200 },
    open: {
      calendar: true,
      files: true,
      search: false,
      windows: true,
      assistant: true,
      // The "Add entry" panel keeps the drawer's old habit of opening collapsed.
      entry: false,
    },
    leftW: 248,
    rightW: 340,
    bottomH: 280,
  };
}

/**
 * Owns the dock layout: which panel sits in which dock and in what order,
 * each panel's height weight and collapse state, and the two dock widths.
 * Persisted synchronously to `localStorage` (per-machine window chrome, not
 * note data -- same reasoning as `LayoutService`), read back before first
 * paint so the layout doesn't jump.
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

  private readonly state = signal<DockState>(this.read());

  /** The panel being dragged by its header, else null. */
  readonly dragging = signal<PanelId | null>(null);
  /** Where the drag would drop it right now. */
  readonly dropDock = signal<DockSide | null>(null);
  readonly dropIndex = signal<number | null>(null);
  /** True while a splitter or dock-edge is being dragged. */
  readonly resizing = signal(false);

  /** Host elements, registered by the components, for hit-testing during a drag. */
  private readonly panelEls = new Map<PanelId, HTMLElement>();
  private readonly dockEls = new Map<DockSide, HTMLElement>();

  readonly leftIds = computed(() => this.state().dock.left);
  readonly rightIds = computed(() => this.state().dock.right);
  readonly bottomIds = computed(() => this.state().dock.bottom);
  readonly hasLeft = computed(() => this.state().dock.left.length > 0);
  readonly hasRight = computed(() => this.state().dock.right.length > 0);
  readonly hasBottom = computed(() => this.state().dock.bottom.length > 0);

  idsFor(side: DockSide): PanelId[] {
    return this.state().dock[side];
  }

  sideOf(id: PanelId): DockSide | null {
    const { dock } = this.state();
    return DOCK_SIDES.find((side) => dock[side].includes(id)) ?? null;
  }

  collapsed(id: PanelId): boolean {
    return !this.state().open[id];
  }

  /** True for a panel sized to its content rather than a `flex-grow` share. */
  contentHeight(id: PanelId): boolean {
    return CONTENT_HEIGHT_PANELS.has(id);
  }

  flexOf(id: PanelId): number {
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

  toggleCollapse(id: PanelId): void {
    this.patch((s) => ({ ...s, open: { ...s.open, [id]: !s.open[id] } }));
  }

  /** Expand a panel and make sure it is docked -- File -> "Switch vault …" / Edit -> "Search all notes". */
  openAndExpand(id: PanelId): void {
    this.patch((s) => {
      if (s.open[id] && this.sideOf(id)) {
        return s;
      }
      const next: DockState = { ...s, open: { ...s.open, [id]: true } };
      if (!DOCK_SIDES.some((side) => s.dock[side].includes(id))) {
        next.dock = { ...s.dock, left: [...s.dock.left, id] };
      }
      return next;
    });
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
    this.state.set(defaultState());
    this.persist();
  }

  /** The first open panel after `id` in the same dock, or null -- what a splitter connects to. */
  nextOpenId(id: PanelId): PanelId | null {
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

  registerPanelEl(id: PanelId, el: HTMLElement): void {
    this.panelEls.set(id, el);
  }

  unregisterPanelEl(id: PanelId, el: HTMLElement): void {
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

  // ---- panel header drag ----

  startPanelDrag(id: PanelId, event: MouseEvent): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    this.dragging.set(id);
    this.dropDock.set(null);
    this.dropIndex.set(null);
    this.setGlobalGesture('grabbing');
    window.addEventListener('mousemove', this.onDragMove);
    window.addEventListener('mouseup', this.onDragEnd);
  }

  private readonly onDragMove = (event: MouseEvent): void => {
    const left = this.dockEls.get('left')?.getBoundingClientRect();
    const right = this.dockEls.get('right')?.getBoundingClientRect();
    const bottom = this.dockEls.get('bottom')?.getBoundingClientRect();
    const t = DockService.DOCK_TOLERANCE;

    let target: DockSide;
    if (
      bottom &&
      event.clientY >= bottom.top - t &&
      event.clientX >= bottom.left - t &&
      event.clientX <= bottom.right + t
    ) {
      target = 'bottom';
    } else if (left && event.clientX <= left.right + t) {
      target = 'left';
    } else if (right && event.clientX >= right.left - t) {
      target = 'right';
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

  private readonly onDragEnd = (): void => {
    window.removeEventListener('mousemove', this.onDragMove);
    window.removeEventListener('mouseup', this.onDragEnd);
    this.setGlobalGesture(null);

    const id = this.dragging();
    const target = this.dropDock();
    const index = this.dropIndex();
    this.dragging.set(null);
    this.dropDock.set(null);
    this.dropIndex.set(null);
    if (!id || !target || index === null) {
      return;
    }
    this.move(id, target, index);
  };

  /** Move `id` to `dock` so it lands at visual slot `index` (drop-line position). */
  move(id: PanelId, dock: DockSide, index: number): void {
    this.patch((s) => {
      const from = s.dock[dock].slice(0, index).filter((x) => x !== id).length;
      const lists: Record<DockSide, PanelId[]> = {
        left: s.dock.left.filter((x) => x !== id),
        right: s.dock.right.filter((x) => x !== id),
        bottom: s.dock.bottom.filter((x) => x !== id),
      };
      lists[dock].splice(from, 0, id);
      return { ...s, dock: lists };
    });
  }

  // ---- splitter (height redistribution between two neighbours) ----

  startSplit(aId: PanelId, bId: PanelId, event: PointerEvent): void {
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
  }

  private patch(fn: (s: DockState) => DockState): void {
    this.state.update(fn);
    this.persist();
  }

  private persist(): void {
    try {
      const { dock, flexes, open, leftW, rightW, bottomH } = this.state();
      localStorage.setItem(
        DockService.KEY,
        JSON.stringify({ dock, flexes, open, leftW, rightW, bottomH }),
      );
    } catch {
      // Private-mode / storage-disabled: a non-persisted session is fine.
    }
  }

  private read(): DockState {
    const base = defaultState();
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
    const clean = (list: unknown): PanelId[] =>
      Array.isArray(list)
        ? list.filter((x): x is PanelId => ALL_PANELS.includes(x as PanelId))
        : [];

    const left = clean(saved.dock?.left);
    const right = clean(saved.dock?.right);
    const bottom = clean(saved.dock?.bottom);
    const placed = new Set<PanelId>([...left, ...right, ...bottom]);
    // Any panel missing from the stored docks (e.g. one added by an app
    // update, like `entry`) goes back to wherever the defaults keep it.
    for (const id of ALL_PANELS) {
      if (!placed.has(id)) {
        const home = base.dock.left.includes(id)
          ? left
          : base.dock.right.includes(id)
            ? right
            : bottom;
        home.push(id);
      }
    }

    const num = (v: unknown, fallback: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? v : fallback;

    return {
      dock: { left, right, bottom },
      flexes: Object.fromEntries(
        ALL_PANELS.map((id) => [id, num(saved.flexes?.[id], base.flexes[id])]),
      ) as Record<PanelId, number>,
      open: Object.fromEntries(
        ALL_PANELS.map((id) => [
          id,
          typeof saved.open?.[id] === 'boolean' ? saved.open[id] : base.open[id],
        ]),
      ) as Record<PanelId, boolean>,
      leftW: Math.max(WIDTH.min, Math.min(WIDTH.max, num(saved.leftW, base.leftW))),
      rightW: Math.max(WIDTH.min, Math.min(WIDTH.max, num(saved.rightW, base.rightW))),
      bottomH: Math.max(HEIGHT.min, Math.min(HEIGHT.max, num(saved.bottomH, base.bottomH))),
    };
  }
}
