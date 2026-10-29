/**
 * The board's blocked-by view helpers (T-0050): the card chips' badge
 * lines, the drop-confirmation predicate, and the "hide blocked" view
 * state. Pure DOM-free logic so the spec runs without a DOM (the
 * plugin spec project has none by policy) — the board wires the real
 * `window.localStorage`, the same pattern as `column-collapse.ts`.
 *
 * The hide-blocked filter is pure view state (ADR-0076 keeps the repo
 * free of board state; decision 9): it hides cards, it never reorders
 * anything — ordering (pins, derived order) stays exactly as assembled.
 */
import { parseHandover, type TicketCard } from '../shared/tickets';

const STORAGE_KEY = 'drey.tickets.hideBlocked';

interface HiddenState {
  hidden: boolean;
}

/** The badge for a blocked card: "blocked by T-0048, T-0047" — the open
 *  blocker ids, in the order the dependencies were written; null hides
 *  the chip (unblocked cards show nothing). */
export function blockedBadge(card: TicketCard): string | null {
  if (card.blocked.length === 0) {
    return null;
  }
  return `blocked by ${card.blocked.join(', ')}`;
}

/** The badge for a blocking card: "blocks T-0049" — the currently
 *  blocked dependents (open edges only; a satisfied blocker shows
 *  nothing); null hides the chip. */
export function blocksBadge(card: TicketCard): string | null {
  if (card.blocks.length === 0) {
    return null;
  }
  return `blocks ${card.blocks.join(', ')}`;
}

/** A manual move of a blocked card into an agent column asks first
 *  (the owner is the final authority); every other target never asks. */
export function needsBlockedConfirm(card: TicketCard, targetHandover: string): boolean {
  return card.blocked.length > 0 && parseHandover(targetHandover).mode === 'agent';
}

/** What the store needs from localStorage — nothing more. */
export interface HideBlockedStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface HideBlockedStore {
  isHidden(): boolean;
  setHidden(value: boolean): void;
}

export function createHideBlockedStore(storage: HideBlockedStorage): HideBlockedStore {
  let hidden = readHidden(storage);

  const persist = (): void => {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({ hidden } satisfies HiddenState));
    } catch {
      // Storage disabled / quota: a non-persisted session is fine.
    }
  };

  return {
    isHidden: () => hidden,
    setHidden(value) {
      if (value === hidden) {
        return;
      }
      hidden = value;
      persist();
    },
  };
}

function readHidden(storage: HideBlockedStorage): boolean {
  try {
    const raw = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}') as Partial<HiddenState>;
    return raw.hidden === true;
  } catch {
    return false;
  }
}
