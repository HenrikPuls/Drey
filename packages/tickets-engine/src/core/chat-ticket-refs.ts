/**
 * The ticket ids an owner types into the chat (D-7a). The board digest only
 * lists open tickets, so a ticket the owner names — `T-0091`, `t-91`, `#91`
 * — is read on demand and handed to the model. Pure: the chat service owns
 * the reading.
 */

/** At most this many tickets ride one turn; a pasted log cannot flood the prompt. */
export const MAX_NAMED_TICKETS = 5;

/** `T-91` / `t-0091` (a letter before it, as in `ST-91`, is no ticket), or `#91` after a non-word character. */
const REF = /(?<![A-Za-z0-9_-])[Tt]-(\d{1,6})(?!\d)|(?<![\w&#])#(\d{1,6})(?!\d)/g;

/** Canonical ids (`T-0091`) in order of first appearance, duplicates dropped, capped. */
export function ticketRefsOf(text: string): readonly string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(REF)) {
    const id = `T-${(match[1] ?? match[2])!.padStart(4, '0')}`;
    if (!ids.includes(id)) {
      ids.push(id);
      if (ids.length === MAX_NAMED_TICKETS) {
        break;
      }
    }
  }
  return ids;
}
