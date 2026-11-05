import type { TicketCard } from './tickets';

/** The remote refine's outcome: the new revision, a conflict flag, or the refusal. */
export interface RefineReply {
  readonly ok: boolean;
  readonly error?: string;
  readonly warning?: string;
  readonly conflict?: boolean;
  readonly revision?: string;
}

/** One ticket as the ticket view reads it: the card and the file text. */
export type TicketReply =
  | { readonly ok: true; readonly card: TicketCard; readonly text: string; readonly revision: string }
  | { readonly ok: false; readonly error: string };

/** An image upload's outcome: the vault-relative file it saved, or why not. */
export interface AttachmentReply {
  readonly ok: boolean;
  readonly file?: string;
  readonly error?: string;
  readonly warning?: string;
}

/** Where a dricket ticket's document is: the store's checkout and the checkout-relative path (E14-4c). */
export interface TicketDocumentLocation {
  readonly checkout: string;
  readonly path: string;
}

/**
 * The editor save of a ticket document (E14-4c): the document as stored after the
 * write, the document as stored when the ticket moved on (dk exit 12, nothing written),
 * or dk's refusal.
 */
export type DocumentSaveReply =
  | { readonly ok: true; readonly text: string; readonly rev: number }
  | { readonly ok: false; readonly conflict: { readonly text: string; readonly rev: number | null } }
  | { readonly ok: false; readonly error: string };
