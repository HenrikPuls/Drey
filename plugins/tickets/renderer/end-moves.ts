import { parseHandover, type BoardColumn } from '../shared/tickets';

/**
 * The interactive dialog's end moves (req-65): which mode a column
 * offers ("Plan with agent") and which owner moves end a dialog there.
 * The "Refine with agent" checkpoint dialog is gone (E13-9): shaping an
 * idea is the ticket file plus Mission Control in the Assistant. Pure — the renderer and its specs share it.
 */

export type InteractiveMode = 'plan';

export interface EndMove {
  readonly label: string;
  readonly title: string;
  /** The phase the owner move targets (the ordinary transition). */
  readonly toPhase: string;
}

/**
 * True when the column hands the ticket to a machine — an agent pool or a
 * CI handover — so the owner never dialogs there: the runner (or the
 * pipeline) works it, the takeover tab is the machine's (req-72).
 */
function isAuto(phase: BoardColumn['phase']): boolean {
  const mode = parseHandover(phase.handover).mode;
  return mode === 'agent' || mode === 'ci';
}

/**
 * The interactive mode a column offers, or null when none does: only the
 * pipeline's first automatic column plans ("Plan with agent"). The manual
 * columns offered "Refine with agent" until E13-9 removed it; the terminal
 * column is where tickets end — no dialog to have there.
 */
export function interactiveModeFor(phaseId: string, columns: readonly BoardColumn[]): InteractiveMode | null {
  const index = columns.findIndex((c) => c.phase.id === phaseId);
  if (index < 0 || index === columns.length - 1) {
    return null;
  }
  const autoIndexes = columns.map((c, i) => (isAuto(c.phase) ? i : -1)).filter((i) => i >= 0);
  return autoIndexes[0] === index ? 'plan' : null;
}

/**
 * The moves that end a dialog in `phaseId`, in click order. A plan
 * dialog finishes into the next column or, when the owner treated the
 * open points themselves, approves straight past their checkpoint. Every
 * move is an owner move — a transition, never a gate-checked fleet move.
 * A run persisted by a release that still had the refine dialog offers
 * none.
 */
export function interactiveEndMoves(mode: InteractiveMode, phaseId: string, columns: readonly BoardColumn[]): readonly EndMove[] {
  const index = columns.findIndex((c) => c.phase.id === phaseId);
  if (index < 0 || (mode as string) !== 'plan') {
    return [];
  }
  const next = columns[index + 1]?.phase ?? null;
  const after = columns[index + 2]?.phase ?? null;
  const moves: EndMove[] = [];
  if (next !== null) {
    moves.push({
      label: `Finish → ${next.title}`,
      toPhase: next.id,
      title: `The dialog is done — move the ticket to ${next.title} (your move, as always at a checkpoint)`,
    });
  }
  if (after !== null) {
    moves.push({
      label: `Approve → ${after.title}`,
      toPhase: after.id,
      title: `You settled the open points in this dialog — skip your own checkpoint and feed ${after.title} directly`,
    });
  }
  return moves;
}
