import { splitFrontmatter } from '../../../../shared/frontmatter';
import { PERSONAS_DIR } from './persona';

/**
 * The persona thread (ADR-0088, U4 — concept §4.5): the owner's coaching
 * protocol, one Markdown file per persona under
 * `tickets/_meta/personas/<id>/thread.md`, shaped like a chat session
 * (core/chat-session.ts) so it stays openable in Drey's editor:
 *
 *     ---
 *     title: "Pia"
 *     created: '2026-11-03T09:00:00.000Z'
 *     ---
 *
 *     - '2026-11-03T09:01:00.000Z' owner — Treat rank fields as the owner's word
 *     - '2026-11-03T09:04:00.000Z' owner — Ask before any dependency bump
 *
 * Writes are strict — exactly the line shape above, one line per message
 * (a multi-line message flattens to one); the reader forgives: an
 * unreadable line is skipped, never a guess (ADR-0076's asymmetric
 * tolerance). The last lines ride every persona run's instruction as the
 * `## Coaching` slice (fleet/context-pack.ts), so what the owner taught
 * in conversation reaches the next dispatch.
 */

export interface PersonaThreadMessage {
  /** The message instant (ISO). */
  readonly at: string;
  /** The message's author role; only the owner writes this file today. */
  readonly role: 'owner';
  /** The message text, one line. */
  readonly text: string;
}

const NL = String.fromCharCode(10);

/** The vault-relative path of one persona's coaching thread. */
export function threadPathFor(id: string): string {
  return `${PERSONAS_DIR}/${id}/thread.md`;
}

/** The strict canonical shape of a fresh thread file. */
export function newThreadText(title: string, now: Date): string {
  const name = title.trim() === '' ? 'Coaching' : title.trim();
  return `---\ntitle: "${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\ncreated: '${now.toISOString()}'\n---\n\n`;
}

/** Appends one owner message as exactly one line; empty messages refuse. */
export function appendThreadOwner(text: string, now: Date, message: string): string {
  const line = message.trim().replace(/\s*\r?\n\s*/g, ' ');
  if (line === '') {
    throw new Error('a thread message is one non-empty line');
  }
  return `${text.endsWith('\n') ? text : `${text}\n`}- '${now.toISOString()}' owner — ${line}\n`;
}

/** Reads a thread file back; the body only — the frontmatter is not messages. */
export function parseThread(text: string): readonly PersonaThreadMessage[] {
  const { body, hadFence } = splitFrontmatter(text);
  const source = hadFence ? body : text;
  const messages: PersonaThreadMessage[] = [];
  for (const line of source.split(NL)) {
    const match = /^- '([^']+)' owner — (.*)$/.exec(line);
    if (match !== null) {
      messages.push({ at: match[1]!, role: 'owner', text: match[2]! });
    }
  }
  return messages;
}
