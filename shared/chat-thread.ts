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

import type { ChatMessage } from './llm';

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

/**
 * The prior thread turned into OpenAI-style chat turns so a follow-up
 * question is answered *in context* rather than from scratch. `question`
 * cards become `user` turns, `summary` / `answer` cards `assistant` turns;
 * the summary is prefixed so the model reads it as background rather than
 * as its own last reply.
 *
 * The caller passes the thread **before** appending the new question (that
 * goes to `ActionRunner.ask` as its own argument). A dangling trailing
 * `user` turn -- a question whose generation failed -- is dropped so the
 * request never sends two `user` messages in a row.
 *
 * `maxMessages` caps the replayed turns to keep a long thread from
 * crowding out the document in a local model's context window; when it
 * bites, the oldest turns are dropped but a leading `summary` is kept.
 */
export function historyForAsk(thread: ChatThread, maxMessages = 12): ChatMessage[] {
  const messages: ChatMessage[] = thread.cards.map((card) => ({
    role: card.role === 'question' ? 'user' : 'assistant',
    content: card.role === 'summary' ? `Note summary: ${card.text}` : card.text,
  }));
  while (messages.length > 0 && messages[messages.length - 1].role === 'user') {
    messages.pop();
  }
  if (messages.length <= maxMessages) {
    return messages;
  }
  const keepSummary = thread.cards[0]?.role === 'summary';
  const head = keepSummary ? [messages[0]] : [];
  return [...head, ...messages.slice(messages.length - (maxMessages - head.length))];
}
