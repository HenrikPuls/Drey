/**
 * The ticket header of a dricket store's document (D-23). The files parser knows
 * `tickets/<dir>/T-nnnn.md` and the YAML schema; a store document is neither. Its
 * header model is the board's card, which the engine already built from the record;
 * only the title comes from the buffer, so an unsaved rename shows at once.
 *
 * The title edit changes the flat front matter's one line and goes back into the
 * editor's buffer like every header edit: Ctrl+S then saves through the route, one
 * `dk put --if-version`.
 */
import type { BoardSnapshot, TicketIssue, TicketMeta } from '../shared/tickets';
import { idInVaultPath } from '../../../packages/tickets-engine/src/store/document-paths';
import { flatText, parseFlatDocument, withFlatField } from '../../../packages/tickets-engine/src/store/flat-frontmatter';

export type StoreHeaderReply =
  | { readonly ok: true; readonly meta: TicketMeta; readonly issues: readonly TicketIssue[]; readonly frontmatter?: string }
  | { readonly ok: false; readonly error: string };

/** Whether a path is a store's document, whose header is answered here. */
export function isStoreDocumentPath(path: string): boolean {
  return idInVaultPath(path) !== null;
}

/** The header model of a store document: the card's, with the title the buffer says. */
export function storeDocumentHeader(path: string, frontmatter: string, snapshot: BoardSnapshot): StoreHeaderReply {
  const id = idInVaultPath(path);
  const card = snapshot.columns.flatMap((column) => column.tickets).find((ticket) => ticket.id === id);
  if (card === undefined) {
    return { ok: false, error: `${id ?? path} is not on the board.` };
  }
  const title = flatText(parseFlatDocument(`${frontmatter}\n`).fields['title']) ?? card.meta.title;
  return { ok: true, meta: { ...card.meta, title }, issues: card.issues };
}

/** A header edit on a store document. The header edits only the title; anything else is refused. */
export function storeDocumentHeaderEdit(path: string, frontmatter: string, patch: Readonly<Record<string, unknown>>, snapshot: BoardSnapshot): StoreHeaderReply {
  const title = patch['title'];
  if (typeof title !== 'string' || Object.keys(patch).length !== 1) {
    return { ok: false, error: 'A ticket document of a store changes only its title here.' };
  }
  try {
    const next = withFlatField(frontmatter, 'title', title);
    const header = storeDocumentHeader(path, next, snapshot);
    return header.ok ? { ...header, frontmatter: next } : header;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
