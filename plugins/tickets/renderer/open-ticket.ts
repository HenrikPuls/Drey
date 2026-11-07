/**
 * The one way a ticket's document opens (D-27). The store decides where a ticket
 * lives: on a dricket board the document is a file of the store's checkout and the
 * card's `path` is a stand-in no file has (`tickets/inbox/T-0092.md`), so every entry
 * point (Create, a Work row, the Board, a link, the OS notification) asks here first
 * and the vault file is the answer only when the store says the ticket is not its own.
 */
export interface TicketOpenDeps {
  /** The `ticketDocument` IPC: where the store keeps this ticket. */
  readonly locate: (id: string) => Promise<TicketDocumentReply>;
  readonly open: (path: string, vaultId: string) => Promise<unknown>;
  readonly showMessage: (text: string) => Promise<unknown>;
  /** The board's vault, for a ticket of the files backend; null without a board. */
  readonly boardVaultId: () => string | null;
}

export interface TicketDocumentReply {
  readonly ok: boolean;
  readonly document?: { readonly vaultId: string; readonly path: string } | null;
  readonly error?: string;
}

/**
 * Opens the ticket `id`. `filePath` is what the card or the create reply names: opened
 * only on the files backend. A declined or failed checkout registration is told once.
 */
export async function openTicketDocument(deps: TicketOpenDeps, id: string, filePath: string): Promise<void> {
  let reply: TicketDocumentReply | null;
  try {
    reply = await deps.locate(id);
  } catch {
    // The engine did not answer: the files backend's path is still the best guess.
    reply = null;
  }
  if (reply !== null && !reply.ok) {
    await deps.showMessage(reply.error ?? 'The ticket document could not be opened.');
    return;
  }
  if (reply?.document != null) {
    await deps.open(reply.document.path, reply.document.vaultId);
    return;
  }
  const vaultId = deps.boardVaultId();
  if (vaultId !== null) {
    await deps.open(filePath, vaultId);
  }
}
