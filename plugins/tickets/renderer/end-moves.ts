import { parseHandover, type BoardColumn } from '../shared/tickets';

/**
 * The interactive dialog's end moves (req-65): which mode a column
 * offers ("Plan with agent" / "Refine with agent") and which owner
 * moves end a dialog there. Pure — the renderer and its specs share it.
 */

export type InteractiveMode = 'plan' | 'refine';

export interface EndMove {
  readonly label: string;
  readonly title: string;
  /** The phase the owner move targets (the ordinary transition). */
  readonly toPhase: string;
}

/** True when the column's handover hands tickets to an agent pool (the
 *  same rule the dispatcher applies — shared/tickets' handover grammar). */
function isAuto(phase: BoardColumn['phase']): boolean {
  return parseHandover(phase.handover).mode === 'agent';
}

/**
 * The interactive mode a column offers, or null when none does: the
 * pipeline's first automatic column plans ("Plan with agent"), the
 * owner's checkpoints — manual columns behind an automatic one — and
 * the last automatic column refine ("Refine with agent").
 */
export function interactiveModeFor(phaseId: string, columns: readonly BoardColumn[]): InteractiveMode | null {
  const autoIndexes = columns.map((c, i) => (isAuto(c.phase) ? i : -1)).filter((i) => i >= 0);
  if (autoIndexes.length === 0) {
    return null;
  }
  const index = columns.findIndex((c) => c.phase.id === phaseId);
  if (index < 0) {
    return null;
  }
  const first = autoIndexes[0]!;
  const last = autoIndexes[autoIndexes.length - 1]!;
  if (index === first) {
    return 'plan';
  }
  // The terminal column is where tickets end — no dialog to have there,
  // even though it sits behind an automatic one (a checkpoint by the
  // machine's definition, never by use).
  if (index === columns.length - 1) {
    return null;
  }
  const previousIsAuto = index > 0 && isAuto(columns[index - 1]!.phase);
  if (!isAuto(columns[index]!.phase) && previousIsAuto) {
    return 'refine'; // an owner checkpoint: the machine never pulls across it
  }
  if (index === last && last !== first) {
    return 'refine'; // the last agent column (e.g. commit)
  }
  return null;
}

/**
 * The moves that end a dialog in `phaseId`, in click order. A plan
 * dialog finishes into the next column or, when the owner treated the
 * open points themselves, approves straight past their checkpoint; a
 * refine dialog goes on to the next column or back to the nearest
 * agent column for rework. Every move is an owner move — a transition,
 * never a gate-checked fleet move.
 */
export function interactiveEndMoves(mode: InteractiveMode, phaseId: string, columns: readonly BoardColumn[]): readonly EndMove[] {
  const index = columns.findIndex((c) => c.phase.id === phaseId);
  if (index < 0) {
    return [];
  }
  const next = columns[index + 1]?.phase ?? null;
  if (mode === 'plan') {
    const moves: EndMove[] = [];
    if (next !== null) {
      moves.push({
        label: `Finish → ${next.title}`,
        toPhase: next.id,
        title: `The dialog is done — move the ticket to ${next.title} (your move, as always at a checkpoint)`,
      });
    }
    const after = columns[index + 2]?.phase ?? null;
    if (after !== null) {
      moves.push({
        label: `Approve → ${after.title}`,
        toPhase: after.id,
        title: `You settled the open points in this dialog — skip your own checkpoint and feed ${after.title} directly`,
      });
    }
    return moves;
  }
  const moves: EndMove[] = [];
  if (next !== null) {
    moves.push({
      label: `On to ${next.title}`,
      toPhase: next.id,
      title: `The checkpoint is settled — move the ticket on to ${next.title} (your move)`,
    });
  }
  for (let i = index - 1; i >= 0; i--) {
    const candidate = columns[i]!.phase;
    if (isAuto(candidate)) {
      moves.push({
        label: `Back to ${candidate.title}`,
        toPhase: candidate.id,
        title: `The findings need rework — send the ticket back to ${candidate.title}`,
      });
      break;
    }
  }
  return moves;
}
