import * as path from 'node:path';

import type { DocumentRoute, DocumentRouteSaveResult } from '../../../shared/plugin-api';
import type { DocumentSaveReply, TicketDocumentLocation } from '../../../packages/tickets-engine/src/contracts/replies';
import { TICKETS_DIR, documentTitle } from '../../../packages/tickets-engine/src/store/document-paths';
import { ticketPathParts } from '../../../packages/tickets-engine/src/core/ticket-files';
import { parseDocument } from 'yaml';
import { splitFrontmatter } from '../../../shared/frontmatter';

/**
 * Ticket documents of a dricket store in the editor (E14-4c, ADR-0090).
 *
 * The store's checkout is a registered Drey vault (or lies inside one); a ticket's
 * `tickets/<prefix>/<shard>/<id>/ticket.md` opens in an ordinary tab from it. This
 * class is the plugin's half of the base seam `ctx.vault.routeDocuments`: it owns the
 * checkout's `tickets/` tree, so the editor's save goes to the engine's
 * `saveDocument` (`dk put --claim --if-version`) instead of writing the file, and the
 * base refuses every other write of that tree. It decides nothing about a ticket.
 */
export interface TicketDocumentsDeps {
  readonly vaults: () => Promise<readonly { readonly id: string; readonly path: string; readonly exists: boolean }[]>;
  /** The checkout while `tickets.backend` is `dricket`, else null. */
  readonly checkout: () => Promise<string | null>;
  readonly locate: (id: string) => Promise<TicketDocumentLocation | null>;
  readonly saveDocument: (input: { path: string; text: string; force: boolean }) => Promise<DocumentSaveReply>;
  /** Asks the user, then registers the folder as a vault; false when they decline. */
  readonly registerCheckout: (checkout: string) => Promise<boolean>;
  readonly modifiedMs: (absolutePath: string) => Promise<number>;
  /** Flags the vaults that hold the checkout as plugin-managed (SDK 1.45): Source control then refuses its writes. */
  readonly markManaged?: (vaultIds: readonly string[]) => void;
  readonly platform?: NodeJS.Platform;
}

export type OpenTicketDocument =
  | { readonly ok: true; readonly document: { readonly vaultId: string; readonly path: string } | null }
  | { readonly ok: false; readonly error: string };

interface Owned {
  readonly vaultId: string;
  /** The checkout's path inside the vault, with a trailing slash; empty when the vault is the checkout. */
  readonly prefix: string;
}

/** The window surface the prompt needs: the Electron seam, so the spec runs without a display. */
export interface PromptWindow {
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

export interface CheckoutPromptDeps<W extends PromptWindow> {
  /** The app window, or null when there is none. */
  readonly window: () => W | null;
  readonly showMessageBox: (parent: W | null, options: MessageBoxOptions) => Promise<{ readonly response: number }>;
  readonly register: (checkout: string) => Promise<unknown>;
}

interface MessageBoxOptions {
  readonly type: 'question';
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  readonly buttons: string[];
  readonly defaultId: number;
  readonly cancelId: number;
}

/**
 * The one question before a checkout becomes a vault (D-14): a prompt without a parent
 * window stays behind the app and looks like nothing happened, so the app comes to the
 * front and the prompt is modal to it.
 */
export async function askToAddCheckout<W extends PromptWindow>(deps: CheckoutPromptDeps<W>, checkout: string): Promise<boolean> {
  const window = deps.window();
  if (window !== null) {
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  }
  const answer = await deps.showMessageBox(window, {
    type: 'question',
    title: 'Tickets',
    message: 'Add the ticket checkout as a vault?',
    detail: `${checkout}\n\nTicket documents open in the editor from this folder. They stay read-only except for saving a ticket, which goes through dricket.`,
    buttons: ['Add vault', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (answer.response !== 0) {
    return false;
  }
  await deps.register(checkout);
  return true;
}

/**
 * The files store's ticket as a tab name, `T-0017 · A8 large modules`. Only a file whose
 * header carries the id its name says: a note that happens to sit under `tickets/` keeps its name.
 */
export function fileTicketTitle(relPath: string, content: string): string | null {
  const parts = ticketPathParts(relPath);
  if (parts === null) {
    return null;
  }
  const { yamlText, hadFence } = splitFrontmatter(content);
  if (!hadFence || yamlText === null) {
    return null;
  }
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0 || doc.get('id') !== parts.stem) {
    return null;
  }
  const title = doc.get('title');
  return typeof title === 'string' && title.trim() !== '' ? `${parts.stem} · ${title.trim()}` : parts.stem;
}

export class TicketDocuments {
  private owned: readonly Owned[] = [];
  private checkoutPath: string | null = null;
  /** The prompt on screen: every further open waits for this one answer (D-14). */
  private asking: Promise<boolean> | null = null;

  constructor(private readonly deps: TicketDocumentsDeps) {}

  /** The route handed to `ctx.vault.routeDocuments`. */
  get route(): DocumentRoute {
    return {
      owns: (vaultId, p) => this.owns(vaultId, p),
      save: (request) => this.save(request),
      title: (vaultId, p, content) => this.title(vaultId, p, content),
    };
  }

  /** The tab's name of a ticket document, either store (D-15, fidelity ruling O6); null for anything else. */
  private title(vaultId: string, p: string, content: string): string | null {
    const normal = p.split('\\').join('/');
    const owned = this.owned.find((o) => o.vaultId === vaultId && normal.startsWith(`${o.prefix}${TICKETS_DIR}/`));
    return owned === undefined ? fileTicketTitle(normal, content) : documentTitle(normal.slice(owned.prefix.length), content);
  }

  private askOnce(checkout: string): Promise<boolean> {
    this.asking ??= this.deps.registerCheckout(checkout).finally(() => {
      this.asking = null;
    });
    return this.asking;
  }

  /** Re-reads which registered vaults contain the checkout; run at activation and when the board refreshes. */
  async refresh(): Promise<void> {
    const checkout = await this.deps.checkout();
    this.checkoutPath = checkout;
    this.owned = checkout === null ? [] : await this.vaultsContaining(checkout);
    this.deps.markManaged?.(this.owned.map((o) => o.vaultId));
  }

  owns(vaultId: string, p: string): boolean {
    const normal = p.split('\\').join('/');
    return this.owned.some((o) => {
      const base = `${o.prefix}${TICKETS_DIR}`;
      return o.vaultId === vaultId && (normal === base || normal.startsWith(`${base}/`));
    });
  }

  /** Where to open the ticket's document: null = not a dricket ticket, open the vault file as before. */
  async open(id: string): Promise<OpenTicketDocument> {
    try {
      await this.refresh();
      const location = await this.deps.locate(id);
      if (location === null) {
        return { ok: true, document: null };
      }
      let owned = this.nearest();
      if (owned === null) {
        if (!(await this.askOnce(location.checkout))) {
          return { ok: false, error: 'The ticket checkout is not a vault, so its documents cannot open in the editor.' };
        }
        await this.refresh();
        owned = this.nearest();
      }
      return owned === null
        ? { ok: false, error: 'The ticket checkout is not a vault, so its documents cannot open in the editor.' }
        : { ok: true, document: { vaultId: owned.vaultId, path: `${owned.prefix}${location.path}` } };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async save(request: { vaultId: string; path: string; body: string; force: boolean }): Promise<DocumentRouteSaveResult> {
    const owned = this.owned.find((o) => o.vaultId === request.vaultId);
    const checkout = this.checkoutPath;
    const normal = request.path.split('\\').join('/');
    if (owned === undefined || checkout === null || !normal.startsWith(owned.prefix)) {
      throw new Error(`${request.path} is not part of the ticket checkout.`);
    }
    const inCheckout = normal.slice(owned.prefix.length);
    const reply = await this.deps.saveDocument({ path: inCheckout, text: request.body, force: request.force });
    const modifiedMs = async (): Promise<number> => this.deps.modifiedMs(path.join(checkout, ...inCheckout.split('/')));
    if ('conflict' in reply) {
      return { conflict: { content: lf(reply.conflict.text), modifiedMs: await modifiedMs() } };
    }
    if (!reply.ok) {
      throw new Error(reply.error);
    }
    return { content: lf(reply.text), modifiedMs: await modifiedMs() };
  }

  private nearest(): Owned | null {
    // The vault whose root is nearest the checkout (shortest prefix).
    return [...this.owned].sort((a, b) => a.prefix.length - b.prefix.length)[0] ?? null;
  }

  private async vaultsContaining(checkout: string): Promise<Owned[]> {
    const fold = (value: string): string => (this.deps.platform ?? process.platform) === 'win32' ? value.toLowerCase() : value;
    const target = path.resolve(checkout);
    const out: Owned[] = [];
    for (const vault of await this.deps.vaults()) {
      if (!vault.exists) {
        continue;
      }
      const relative = path.relative(path.resolve(vault.path), target);
      // path.relative is case-sensitive: fold both sides on Windows before judging.
      const folded = path.relative(fold(path.resolve(vault.path)), fold(target));
      if (folded.startsWith('..') || path.isAbsolute(folded)) {
        continue;
      }
      const inside = relative.startsWith('..') || path.isAbsolute(relative) ? folded : relative;
      out.push({ vaultId: vault.id, prefix: inside === '' ? '' : `${inside.split(path.sep).join('/')}/` });
    }
    return out;
  }
}

const lf = (text: string): string => text.replace(/\r\n/g, '\n');
