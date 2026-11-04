import { PaneNode, leafIds, removeLeaf } from './pane-tree';
import type { PaneDockSide, PaneRecord } from './pane.service';

/**
 * One view's editor layout (ADR-0089): the centre split tree, the panes with
 * their tab strips, the focused pane, the docked editor bands. `PaneService`
 * holds the active view's slot in signals and every other view's slot as a
 * plain value of this shape; the functions below are the pure edits on an
 * inactive slot ("Show this tab in", deleting a view, a rename).
 */
export interface ViewSlot {
  readonly root: PaneNode;
  readonly panes: Record<string, PaneRecord>;
  readonly focusedId: string;
  readonly dockPanes: Record<PaneDockSide, string | null>;
  readonly bandHeights: Record<PaneDockSide, number>;
}

const SIDES: readonly PaneDockSide[] = ['left', 'right', 'bottom'];

/** A slot with one empty centre pane. */
export function emptySlot(paneId: string, bandHeight: number): ViewSlot {
  return {
    root: { kind: 'leaf', paneId },
    panes: { [paneId]: { id: paneId, tabs: [], active: null } },
    focusedId: paneId,
    dockPanes: { left: null, right: null, bottom: null },
    bandHeights: { left: bandHeight, right: bandHeight, bottom: bandHeight },
  };
}

/** Every pane id of the slot: the centre leaves, then the docked bands. */
export function slotPaneIds(slot: ViewSlot): string[] {
  return [
    ...leafIds(slot.root),
    ...SIDES.map((s) => slot.dockPanes[s]).filter((id): id is string => id !== null),
  ];
}

/** Every tab key the slot holds (a key sits in one pane of a slot at most). */
export function slotTabs(slot: ViewSlot): string[] {
  return slotPaneIds(slot).flatMap((id) => slot.panes[id]?.tabs ?? []);
}

export function slotHolds(slot: ViewSlot, key: string): boolean {
  return slotPaneIds(slot).some((id) => slot.panes[id]?.tabs.includes(key) === true);
}

/** Adds `key` as the active tab of the slot's focused pane (a no-op when it is already there). */
export function slotAddTab(slot: ViewSlot, key: string): ViewSlot {
  if (slotHolds(slot, key)) {
    return slot;
  }
  const target = slot.panes[slot.focusedId] ?? slot.panes[slotPaneIds(slot)[0]];
  if (target === undefined) {
    return slot;
  }
  return {
    ...slot,
    panes: { ...slot.panes, [target.id]: { ...target, tabs: [...target.tabs, key], active: key } },
  };
}

/** Removes `key` from the slot; a pane left empty leaves the layout (the last centre pane stays, empty). */
export function slotRemoveTab(slot: ViewSlot, key: string): ViewSlot {
  let next = slot;
  for (const id of slotPaneIds(slot)) {
    const pane = next.panes[id];
    if (pane === undefined || !pane.tabs.includes(key)) {
      continue;
    }
    const idx = pane.tabs.indexOf(key);
    const tabs = pane.tabs.filter((t) => t !== key);
    const active = pane.active === key ? (tabs[idx] ?? tabs[idx - 1] ?? null) : pane.active;
    next = { ...next, panes: { ...next.panes, [id]: { ...pane, tabs, active } } };
    if (tabs.length > 0) {
      continue;
    }
    const dockSide = SIDES.find((s) => next.dockPanes[s] === id);
    if (dockSide !== undefined) {
      const { [id]: _gone, ...rest } = next.panes;
      next = { ...next, panes: rest, dockPanes: { ...next.dockPanes, [dockSide]: null } };
    } else if (!(next.root.kind === 'leaf' && next.root.paneId === id)) {
      const root = removeLeaf(next.root, id);
      const { [id]: _gone, ...rest } = next.panes;
      next = { ...next, root, panes: rest };
    }
  }
  if (next.panes[next.focusedId] === undefined) {
    next = { ...next, focusedId: slotPaneIds(next)[0] ?? next.focusedId };
  }
  return next;
}

/** Re-points `oldKey` at `newKey` in every pane of the slot (a file rename). */
export function slotRenameTab(slot: ViewSlot, oldKey: string, newKey: string): ViewSlot {
  if (!slotHolds(slot, oldKey)) {
    return slot;
  }
  const panes: Record<string, PaneRecord> = {};
  for (const [id, pane] of Object.entries(slot.panes)) {
    panes[id] = {
      ...pane,
      tabs: pane.tabs.map((t) => (t === oldKey ? newKey : t)),
      active: pane.active === oldKey ? newKey : pane.active,
    };
  }
  return { ...slot, panes };
}

/**
 * A copy of the slot under fresh pane and split ids (they stay unique across
 * views, so a mounted pane never mistakes another view's pane for its own).
 */
export function slotRemapIds(slot: ViewSlot, newPaneId: () => string, newSplitId: () => string): ViewSlot {
  const paneMap = new Map<string, string>();
  const mapPane = (id: string): string => {
    let to = paneMap.get(id);
    if (to === undefined) {
      to = newPaneId();
      paneMap.set(id, to);
    }
    return to;
  };
  const mapNode = (node: PaneNode): PaneNode =>
    node.kind === 'leaf'
      ? { kind: 'leaf', paneId: mapPane(node.paneId) }
      : { ...node, id: newSplitId(), children: node.children.map(mapNode) };
  const root = mapNode(slot.root);
  const panes: Record<string, PaneRecord> = {};
  for (const id of slotPaneIds(slot)) {
    const to = mapPane(id);
    panes[to] = { ...slot.panes[id], id: to };
  }
  const dockPanes = { left: null, right: null, bottom: null } as Record<PaneDockSide, string | null>;
  for (const s of SIDES) {
    const id = slot.dockPanes[s];
    dockPanes[s] = id === null ? null : mapPane(id);
  }
  return {
    root,
    panes,
    focusedId: panes[mapPane(slot.focusedId)] !== undefined ? mapPane(slot.focusedId) : Object.keys(panes)[0],
    dockPanes,
    bandHeights: { ...slot.bandHeights },
  };
}
