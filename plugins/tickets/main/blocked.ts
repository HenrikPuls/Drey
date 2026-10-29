/**
 * The blocked-by dependency pass (T-0050): the pure derivation that
 * turns each ticket's `blocked-by:` ids into the board's derived
 * blocked state. No IO — `assembleBoard` feeds it every card in
 * column order, the specs feed it fixtures.
 *
 * The rules (the ticket's Decisions):
 * - Blocked is DERIVED, never stored: a reference is satisfied exactly
 *   when the referenced ticket sits in the pipeline's terminal phase.
 * - A blocker id that resolves to no board ticket (deleted, renamed,
 *   archived) is a visible warning and keeps the dependent blocked —
 *   never a silent unblock. The board never reads `tickets/archive/`.
 * - Self-reference and cycles are one error finding per member, the
 *   message naming the cycle; cyclic members also count as blocked
 *   (a cyclic dependency can never be satisfied, phases aside).
 * - `blocks` is the derived inverse over OPEN edges only: a satisfied
 *   blocker shows nothing.
 *
 * Duplicate ids (already an error finding upstream) resolve to the
 * first occurrence in column order — deterministic, and the
 * pre-existing error already gates the fleet.
 */
import type { TicketCard, TicketIssue } from '../shared/tickets';

export interface DependencyPass {
  /** card id -> open blocker ids (unknown ids included; [] = unblocked). */
  readonly blocked: ReadonlyMap<string, readonly string[]>;
  /** card id -> ids currently blocked by this card (open edges only). */
  readonly blocks: ReadonlyMap<string, readonly string[]>;
  /** Per-card findings to append (warnings, cycle errors). */
  readonly issuesByCard: ReadonlyMap<string, readonly TicketIssue[]>;
}

/** Runs the pass over every card (column order; duplicate ids resolve
 *  to the first occurrence). `terminalPhase` is the pipeline's last
 *  phase — the one phase that satisfies a reference. */
export function runDependencyPass(cards: readonly TicketCard[], terminalPhase: string): DependencyPass {
  // First occurrence in column order wins (a duplicate id is already
  // an upstream error; resolution just stays deterministic).
  const byId = new Map<string, TicketCard>();
  for (const card of cards) {
    if (!byId.has(card.id)) {
      byId.set(card.id, card);
    }
  }

  const issues = new Map<string, TicketIssue[]>();
  const push = (id: string, issue: TicketIssue): void => {
    const list = issues.get(id);
    if (list === undefined) {
      issues.set(id, [issue]);
    } else if (!list.some((i) => i.message === issue.message)) {
      list.push(issue);
    }
  };

  // --- resolution: which references are open? ---------------------------
  const blocked = new Map<string, string[]>();
  for (const card of byId.values()) {
    const open: string[] = [];
    for (const ref of card.meta.blockedBy) {
      const blocker = byId.get(ref);
      if (blocker === undefined) {
        push(card.id, { level: 'warning', message: `blocked-by names ${ref}, which is not on the board` });
        open.push(ref);
      } else if (blocker.phase !== terminalPhase) {
        open.push(ref);
      }
    }
    blocked.set(card.id, open);
  }

  // --- cycles: one deterministic DFS over the id graph -------------------
  // Edges are the references that resolve to board tickets (an unknown
  // id has no outgoing edge, so it can never close a cycle).
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of byId.keys()) {
    color.set(id, WHITE);
  }
  const stack: string[] = [];
  const membersOf = new Map<string, Set<string>>();
  const visit = (id: string): void => {
    color.set(id, GRAY);
    stack.push(id);
    for (const ref of byId.get(id)!.meta.blockedBy) {
      if (!byId.has(ref)) {
        continue;
      }
      const state = color.get(ref);
      if (state === WHITE) {
        visit(ref);
      } else if (state === GRAY) {
        // The cycle runs from `ref` (still on the stack) back to `ref`.
        const at = stack.indexOf(ref);
        const cycle = [...stack.slice(at), ref];
        const members = new Set(cycle.slice(0, -1));
        for (const member of members) {
          push(member, { level: 'error', message: `blocked-by cycle: ${cycle.join(' -> ')}` });
          const seen = membersOf.get(member);
          if (seen === undefined) {
            membersOf.set(member, members);
          } else {
            for (const entry of members) {
              seen.add(entry);
            }
          }
        }
      }
    }
    stack.pop();
    color.set(id, BLACK);
  };
  for (const id of [...byId.keys()].sort()) {
    if (color.get(id) === WHITE) {
      visit(id);
    }
  }
  // A cyclic dependency can never be satisfied: a member whose open
  // list came out empty (its cycle neighbours sit in the terminal
  // phase) is blocked by those neighbours regardless.
  for (const [id, members] of membersOf) {
    const open = blocked.get(id)!;
    for (const ref of byId.get(id)!.meta.blockedBy) {
      if (members.has(ref) && !open.includes(ref)) {
        open.push(ref);
      }
    }
  }

  // --- the inverse over open edges ---------------------------------------
  const blocks = new Map<string, string[]>();
  for (const id of byId.keys()) {
    blocks.set(id, []);
  }
  for (const [dependent, open] of blocked) {
    for (const blocker of open) {
      blocks.get(blocker)?.push(dependent);
    }
  }
  for (const list of blocks.values()) {
    list.sort();
  }

  return { blocked, blocks, issuesByCard: issues };
}

/**
 * The manual run start's refusal line (startRun shows it verbatim):
 * null when the card is unblocked. A blocked ticket never enters a
 * worker column's pool — the owner reads why here instead.
 */
export function blockedRefusal(card: TicketCard): string | null {
  if (card.blocked.length === 0) {
    return null;
  }
  return `${card.id} is blocked by ${card.blocked.join(', ')} — the blockers must reach the terminal phase first`;
}
