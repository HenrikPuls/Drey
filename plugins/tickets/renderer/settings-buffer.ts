import { canMove } from './settings-order';
import type { ColumnFieldPatch, ColumnsBatch, FolderStatus, PipelinePhase } from '../shared/tickets';

/**
 * The settings dialog's buffer (T-0043, store-on-leave): structure edits
 * and per-column field diffs accumulate here — DOM-free and pure — until
 * leaving the dialog flushes them as ONE `columns` batch (one commit).
 * Nothing buffered ever touches disk; the buffer is the only writer of
 * the batch, and only what differs from the base state rides it (patch
 * semantics: a hand edit of pipeline.md made while the dialog was open
 * survives).
 */

/** The dialog's anchored view of the board (re-pulled on every reload). */
export interface ColumnsState {
  readonly pipeline: readonly PipelinePhase[];
  readonly folders: FolderStatus;
  readonly promptRefs: readonly string[];
  readonly defaultWorker: string;
  /** Tickets per phase id, from the board snapshot (removal pre-checks). */
  readonly counts: Readonly<Record<string, number>>;
}

/** The buffer itself: readable so the rows render from base + buffer, and
 *  mutated only through the exported functions below. */
export interface ColumnsBuffer {
  /** The anchored disk state (re-anchored by `mergeBuffer`). */
  base: ColumnsState;
  /** The buffered order: base ids minus removals plus adds, terminal last. */
  order: string[];
  /** Buffered adds: id -> title (new columns, manual until staffed). */
  added: Map<string, string>;
  /** Buffered removals of base phases (vanished ones drop on merge). */
  removed: Set<string>;
  /** Accumulated raw field edits per column id, before the base diff. */
  patch: Record<string, ColumnFieldPatch>;
}

export function startBuffer(state: ColumnsState): ColumnsBuffer {
  return {
    base: state,
    order: state.pipeline.map((p) => p.id),
    added: new Map(),
    removed: new Set(),
    patch: {},
  };
}

/** Buffers one column's field edit; undefined keys are untouched. */
export function editColumn(buf: ColumnsBuffer, id: string, patch: ColumnFieldPatch): void {
  if (!buf.order.includes(id)) {
    return;
  }
  const next: Record<string, string | number | null> = { ...buf.patch[id] };
  if (patch.worker !== undefined) {
    next['worker'] = patch.worker ?? '';
  }
  if (patch.model !== undefined) {
    next['model'] = patch.model ?? '';
  }
  if (patch.workers !== undefined) {
    next['workers'] = patch.workers;
  }
  if (patch.prompt !== undefined) {
    next['prompt'] = patch.prompt ?? '';
  }
  buf.patch[id] = next as ColumnFieldPatch;
}

/** Buffers a new column, appended before the terminal (manual, gap folder).
 *  Duplicate or grammar-breaking ids are the modal's refusal, not ours. */
export function addColumn(buf: ColumnsBuffer, id: string, title: string): void {
  if (buf.order.length < 2 || buf.order.includes(id)) {
    return;
  }
  const at = buf.order.length - 1;
  buf.order.splice(at, 0, id);
  buf.added.set(id, title);
}

/** Buffers a removal — refused with a reason when the column still holds
 *  tickets or is the capture target / the terminal. Two-step arming and
 *  the refusal text are the dialog's; the rules are here (pure). */
export function removeColumn(buf: ColumnsBuffer, id: string): { ok: true } | { ok: false; reason: string } {
  const index = buf.order.indexOf(id);
  if (index < 0) {
    return { ok: false, reason: `"${id}" is not a column of the pipeline` };
  }
  const title = buf.added.get(id) ?? buf.base.pipeline.find((p) => p.id === id)?.title ?? id;
  if (index === 0) {
    return { ok: false, reason: `"${title}" is the first column — the capture target for new tickets` };
  }
  if (index === buf.order.length - 1) {
    return { ok: false, reason: `"${title}" is the last column — the terminal` };
  }
  const held = buf.base.counts[id] ?? 0;
  if (held > 0) {
    return {
      ok: false,
      reason: `"${title}" still holds ${held} ${held === 1 ? 'ticket' : 'tickets'} — move or archive ${held === 1 ? 'it' : 'them'} first`,
    };
  }
  buf.order.splice(index, 1);
  if (buf.added.has(id)) {
    // Undoing this session's add: nothing of it ever reaches the batch.
    buf.added.delete(id);
  } else {
    buf.removed.add(id);
  }
  delete buf.patch[id];
  return { ok: true };
}

/** Buffers a move (the ↑/↓, drag and Alt+arrow rules): the first and the
 *  last row never move. False = refused, nothing changed. */
export function moveColumn(buf: ColumnsBuffer, from: number, to: number): boolean {
  if (!canMove(buf.order.length, from, to)) {
    return false;
  }
  const [moved] = buf.order.splice(from, 1);
  if (moved === undefined) {
    return false;
  }
  buf.order.splice(to, 0, moved);
  return true;
}

/**
 * Re-anchors the buffer on fresh disk state without losing buffered
 * edits — the reload path after a structural edit. Deterministic rule:
 * buffered removals and patches whose phase vanished from disk are
 * dropped (someone else already did it); adds are always kept; the
 * surviving ids keep their buffered sequence; phases unknown to the
 * buffer slot in before the terminal, fresh order among themselves.
 */
export function mergeBuffer(buf: ColumnsBuffer, fresh: ColumnsState): void {
  const freshIds = fresh.pipeline.map((p) => p.id);
  const freshSet = new Set(freshIds);
  for (const id of [...buf.removed]) {
    if (!freshSet.has(id)) {
      buf.removed.delete(id);
    }
  }
  const kept = buf.order.filter((id) => buf.added.has(id) || (freshSet.has(id) && !buf.removed.has(id)));
  for (const id of Object.keys(buf.patch)) {
    if (!freshSet.has(id) && !buf.added.has(id)) {
      delete buf.patch[id];
    }
  }
  const unknown = freshIds.filter((id) => !kept.includes(id) && !buf.removed.has(id));
  const merged = [...kept];
  if (merged.length > 0) {
    merged.splice(merged.length - 1, 0, ...unknown);
  } else {
    merged.push(...unknown);
  }
  buf.order.splice(0, buf.order.length, ...merged);
  buf.base = fresh;
}

/** Whether anything is buffered (a clean buffer flushes nothing). */
export function bufferDirty(buf: ColumnsBuffer): boolean {
  return toBatch(buf) !== null;
}

/**
 * The store-on-leave batch: the full buffered order, the adds (at their
 * order position), the removals, and per-column patches reduced to what
 * differs from the base state — a value set back to base omits its key
 * entirely. Null when the buffer is clean.
 */
export function toBatch(buf: ColumnsBuffer): ColumnsBatch | null {
  const add = buf.order
    .filter((id) => buf.added.has(id))
    .map((id) => ({ id, title: buf.added.get(id)! }));
  const remove = [...buf.removed];
  const patch: Record<string, ColumnFieldPatch> = {};
  for (const id of Object.keys(buf.patch)) {
    if (!buf.order.includes(id)) {
      continue;
    }
    const phase = buf.base.pipeline.find((p) => p.id === id);
    const raw = buf.patch[id]!;
    const next: Record<string, string | number | null> = {};
    if (raw.worker !== undefined && (raw.worker ?? '') !== (phase?.worker ?? '')) {
      next['worker'] = raw.worker === '' || raw.worker === null ? null : raw.worker;
    }
    if (raw.model !== undefined && (raw.model ?? '') !== (phase?.model ?? '')) {
      next['model'] = raw.model === '' || raw.model === null ? null : raw.model;
    }
    if (raw.workers !== undefined && (raw.workers ?? 1) !== (phase?.workers ?? 1)) {
      next['workers'] = raw.workers;
    }
    if (raw.prompt !== undefined && (raw.prompt ?? '') !== (phase?.prompt ?? '')) {
      next['prompt'] = raw.prompt === '' || raw.prompt === null ? null : raw.prompt;
    }
    if (Object.keys(next).length > 0) {
      patch[id] = next as ColumnFieldPatch;
    }
  }
  const baseOrder = buf.base.pipeline.map((p) => p.id);
  const sameOrder =
    buf.order.length === baseOrder.length && buf.order.every((id, i) => id === baseOrder[i]);
  if (add.length === 0 && remove.length === 0 && Object.keys(patch).length === 0 && sameOrder) {
    return null;
  }
  return { order: [...buf.order], add, remove, patch };
}

/**
 * The prompt dropdown's options (pure, specced): value `''` IS "the
 * handover's ref" — the label names the ref (`(none)` when the handover
 * names none) — plus every existing ref. A ref whose file is missing
 * shows as a marked extra entry, and the default label carries the mark
 * when the handover's own ref is missing — never silently.
 */
export function promptOptions(
  explicit: string | null,
  handoverRef: string | null,
  refs: readonly string[],
): { value: string; label: string; missing: boolean }[] {
  const exists = (ref: string): boolean => refs.includes(ref);
  const options: { value: string; label: string; missing: boolean }[] = [];
  if (handoverRef === null) {
    options.push({ value: '', label: '(none)', missing: false });
  } else if (exists(handoverRef)) {
    options.push({ value: '', label: `Handover (${handoverRef})`, missing: false });
  } else {
    options.push({ value: '', label: `Handover (${handoverRef}, file missing)`, missing: true });
  }
  const extra = explicit !== null && !exists(explicit) ? [explicit] : [];
  for (const ref of [...new Set([...refs, ...extra])].sort()) {
    options.push({
      value: ref,
      label: exists(ref) ? ref : `${ref} (file missing)`,
      missing: !exists(ref),
    });
  }
  return options;
}
