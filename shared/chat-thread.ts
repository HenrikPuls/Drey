/**
 * The note assistant's sidecar thread: `.{name}.chat.json` next to the
 * note it belongs to (`daily/2026-09-26.md` -> `daily/.2026-09-26.chat.json`).
 *
 * Why a sidecar and not the note itself: the thread is *about* the note,
 * not part of it. Keeping it out of the Markdown means an auto-summary
 * never edits a document the user did not touch, the note stays clean
 * plain Markdown for any other editor (CLAUDE.md storage format), and the
 * dot prefix keeps it out of the file tree and the tag index for free --
 * both already skip dotfiles (`electron/vault-manager.ts`).
 *
 * Parsing is defensive in the same style as `normalizeAppConfig`: a
 * hand-edited or half-written file degrades to an empty thread rather than
 * throwing, because the assistant panel must still open.
 */

/** Who produced a card. `summary` is the automatic note summary. */
export type ChatCardRole = 'summary' | 'question' | 'answer';

export interface ChatCard {
  id: string;
  role: ChatCardRole;
  text: string;
  /** ISO local timestamp (`formatDateTime`) of when the card was created. */
  at: string;
  /**
   * How long the model took to produce this card, in milliseconds. Stored
   * so "took 8s" survives a restart, the same way the timestamp does.
   * Absent on cards that cost no generation (a question the user typed).
   */
  durationMs?: number;
}

export interface ChatThread {
  version: 1;
  /** Vault-relative path of the note this thread belongs to. */
  notePath: string;
  cards: ChatCard[];
}

/** `daily/2026-09-26.md` -> `daily/.2026-09-26.chat.json`. */
export function sidecarPathFor(notePath: string): string {
  const slash = notePath.lastIndexOf('/');
  const dir = slash === -1 ? '' : notePath.slice(0, slash + 1);
  const file = notePath.slice(slash + 1);
  const base = file.replace(/\.md$/i, '');
  return `${dir}.${base}.chat.json`;
}

export function emptyThread(notePath: string): ChatThread {
  return { version: 1, notePath, cards: [] };
}

export function hasSummary(thread: ChatThread): boolean {
  return thread.cards.some((card) => card.role === 'summary');
}

export function parseChatThread(raw: string, notePath: string): ChatThread {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyThread(notePath);
  }
  const source = (parsed ?? {}) as Record<string, unknown>;
  const cards = Array.isArray(source['cards']) ? source['cards'] : [];
  return {
    version: 1,
    notePath,
    cards: cards.flatMap((item, index) => {
      if (!item || typeof item !== 'object') {
        return [];
      }
      const card = item as Record<string, unknown>;
      const text = typeof card['text'] === 'string' ? card['text'] : '';
      if (text.trim() === '') {
        return [];
      }
      const durationMs = card['durationMs'];
      return [
        {
          id: typeof card['id'] === 'string' ? card['id'] : `card-${index}`,
          role: normalizeRole(card['role']),
          text,
          at: typeof card['at'] === 'string' ? card['at'] : '',
          ...(typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0
            ? { durationMs }
            : {}),
        },
      ];
    }),
  };
}

export function serializeChatThread(thread: ChatThread): string {
  return `${JSON.stringify(thread, null, 2)}\n`;
}

function normalizeRole(value: unknown): ChatCardRole {
  return value === 'summary' || value === 'question' ? value : 'answer';
}
