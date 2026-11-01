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
