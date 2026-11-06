import { parseFlatDocument } from './flat-frontmatter';
import { toDisplayId, toDricketId } from './ids';

/**
 * Where a ticket document lives inside a store's checkout (E14-4c), in the
 * layout of dricket's `docs/protocol.md`: `tickets/<prefix>/<shard>/<id>/ticket.md`
 * with the shard being the number divided by 1000, four digits. Paths are
 * checkout-relative with forward slashes. Parse-only knowledge, like the file
 * reader's: no decision of dricket is made here.
 */
export const TICKETS_DIR = 'tickets';

/** `T-0063` -> `tickets/t/0000/t-63/ticket.md`; null when `id` is not a display id. */
export function documentRelPath(id: string, ticketsDir: string = TICKETS_DIR): string | null {
  const mapped = toDricketId(id);
  if (mapped === null) {
    return null;
  }
  const [prefix, number] = mapped.split('-') as [string, string];
  const shard = String(Math.floor(Number(number) / 1000)).padStart(4, '0');
  return `${ticketsDir}/${prefix}/${shard}/${mapped}/ticket.md`;
}

/**
 * What a ticket document is called on screen (D-15), `T-0003 · Pin tabs to the left`,
 * as the thread tab has it: every document's file is `ticket.md`, which tells two open
 * tickets apart from nothing. Null when the path is no ticket document.
 */
export function documentTitle(relPath: string, text: string, ticketsDir: string = TICKETS_DIR): string | null {
  const id = idOfDocumentPath(relPath, ticketsDir);
  if (id === null) {
    return null;
  }
  const title = parseFlatDocument(text).fields['title']?.trim();
  return title === undefined || title === '' ? id : `${id} · ${title}`;
}

const DOCUMENT = /^([^/]+)\/([^/]+)\/([^/]+)\/ticket\.md$/;

/** The display id of a checkout-relative ticket document path, or null when the path is not one. */
export function idOfDocumentPath(relPath: string, ticketsDir: string = TICKETS_DIR): string | null {
  const normal = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normal.startsWith(`${ticketsDir}/`)) {
    return null;
  }
  const m = DOCUMENT.exec(normal.slice(ticketsDir.length + 1));
  if (m === null) {
    return null;
  }
  const display = toDisplayId(m[3]!);
  return documentRelPath(display, ticketsDir) === normal ? display : null;
}
