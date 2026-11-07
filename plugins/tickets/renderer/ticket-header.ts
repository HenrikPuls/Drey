/**
 * The ticket header in the editor (req-62, SDK 1.34; E12-12; boards 9a, 7b, 7c,
 * 7j): an opened ticket shows its card and, when the body opens with no `# h1`
 * of its own, its title as the headline, in place of the base's folded
 * `▸ Frontmatter` pill. Its `## Log` opens folded. A `<>` under the pointer is
 * the way to the raw YAML.
 *
 * The header draws from the BUFFER's frontmatter, not the file on disk
 * (an unsaved edit shows at once). Reading and rewriting the YAML is the
 * plugin's main side (`header` / `headerEdit`, the `yaml` document
 * mutation of `ticket-files.ts` — the renderer bundles no package); the
 * result goes back into the editor as one change, so dirty state, undo,
 * save and the conflict merge stay the editor's.
 */
import type {
  DreyPluginApi,
  EditorSurfaceContext,
  FrontmatterViewContrib,
  FrontmatterViewInput,
} from '../../../shared/plugin-api/renderer';
import { stripPhasePrefix, type BoardSnapshot, type TicketCard, type TicketIssue, type TicketMeta } from '../shared/tickets';
import { idOfDocumentPath } from '../../../packages/tickets-engine/src/store/document-paths';
import { toDisplayId } from '../../../packages/tickets-engine/src/store/ids';
import { maskFenceLines } from '../../../shared/markdown/fences';
import type { TicketStrip } from './ticket-document/strip';

const FILES_TICKET = /^tickets\/(?!_meta\/)[^/]+\/(T-\d{4,})\.md$/;

/**
 * The display id a ticket document's path names — both shapes of the
 * store: the files backend's `tickets/<phase dir>/T-nnnn.md` (archive
 * included) and the dricket store's `tickets/<prefix>/<shard>/t-N/ticket.md`
 * (the engine's document-path contract, read and not changed). Null off a
 * ticket document.
 */
export function ticketIdOfPath(path: string | null): string | null {
  if (path === null) {
    return null;
  }
  const normal = path.split('\\').join('/');
  return FILES_TICKET.exec(normal)?.[1] ?? idOfDocumentPath(normal);
}

/** A ticket document of the board, in either store shape. */
export function isTicketPath(path: string | null): boolean {
  return ticketIdOfPath(path) !== null;
}

/**
 * Whether an editor surface shows one of the board's tickets (D-23). On the
 * files backend a ticket lives in the board's vault, so the vault must match.
 * A dricket store's documents open from the **checkout** vault (E14-4c), which
 * is not the board's: there the path shape plus a ticket the board lists is
 * the proof — a stray `tickets/t/…/ticket.md` in some other vault stays plain.
 */
export function showsTicketDocument(snapshot: BoardSnapshot | null, vaultId: string | null, path: string | null): boolean {
  const id = ticketIdOfPath(path);
  if (id === null || snapshot?.vaultId == null) {
    return false;
  }
  if (vaultId === snapshot.vaultId) {
    return true;
  }
  return idOfDocumentPath((path ?? '').split('\\').join('/')) === id && snapshot.columns.some((c) => c.tickets.some((t) => t.id === id));
}

/**
 * A ticket tab's title, the same for every kind of tab (E12-12): `T-0121 ·
 * Title`. The title is the one the board's model gives (the card's meta) —
 * never derived from the file path; a ticket the board does not know yet
 * shows its id alone.
 */
export function ticketTabTitle(i18n: DreyPluginApi['i18n'], id: string, title: string | null | undefined): string {
  const named = (title ?? '').trim();
  return named === '' ? id : i18n.t('ticket.tab_title', { id, title: named });
}

/**
 * The phase directory's id (`50-build` → `build`), or null off a ticket path.
 * A dricket document's path names no phase (its folders are prefix and shard):
 * there the phase is the card's.
 */
export function phaseOfTicketPath(path: string): string | null {
  if (idOfDocumentPath(path) !== null) {
    return null;
  }
  const match = /^tickets\/([^/]+)\//.exec(path);
  return match === null ? null : stripPhasePrefix(match[1]!);
}

/**
 * The board's card of an open document. A files-backend card's `path` is the
 * document's; a dricket card's is a stand-in the document never has
 * (`tickets/<phase>/T-nnnn.md`, the store's records read as board files), so a
 * store document finds its card by the id its path names (D-23).
 */
export function cardOfDocument(snapshot: BoardSnapshot | null, path: string | null): TicketCard | null {
  if (snapshot === null || path === null) {
    return null;
  }
  const normal = path.split('\\').join('/');
  const storeId = idOfDocumentPath(normal);
  return snapshot.columns.flatMap((c) => c.tickets).find((t) => (storeId === null ? t.path === normal : t.id === storeId)) ?? null;
}

/**
 * The display id a ticket document's text says it is, or undefined. The files
 * backend writes `id: T-0030` (YAML, possibly quoted), the store `id: t-30`.
 */
export function ticketIdOfText(text: string): string | undefined {
  const written = /^id:\s*['"]?(T-\d{4,}|t-[1-9]\d*)/m.exec(text)?.[1];
  return written === undefined || written.startsWith('T-') ? written : toDisplayId(written);
}

/**
 * What the Log fold hides: from the end of the `## Log` heading line to the
 * end of its section (the next heading of level 1–2, or the document end),
 * trailing blank lines left visible. Headings inside a code fence don't
 * count. Null when there is no Log section or it is empty.
 */
export function logSectionRange(text: string): { from: number; to: number } | null {
  let offset = 0;
  let start: number | null = null;
  let end: number | null = null;
  const lines = text.split('\n');
  const scan = maskFenceLines(lines);
  for (const [i, line] of lines.entries()) {
    const lineEnd = offset + line.length;
    if (/^#{1,2}\s/.test(scan[i]!)) {
      if (start !== null) {
        break;
      }
      if (/^##\s+Log\s*$/.test(scan[i]!)) {
        start = lineEnd;
      }
    } else if (start !== null && line.trim() !== '') {
      end = lineEnd;
    }
    offset = lineEnd + 1;
  }
  return start !== null && end !== null && end > start ? { from: start, to: end } : null;
}

/** Whether the ticket's text, after its frontmatter, opens with a `# h1`. */
export function bodyOpensWithHeading(text: string): boolean {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '');
  return /^\s*#[ \t]+\S/.test(body);
}

interface HeaderModel {
  readonly meta: TicketMeta;
  readonly issues: readonly TicketIssue[];
}

interface HeaderReply {
  readonly ok: boolean;
  readonly error?: string;
  readonly frontmatter?: string;
  readonly meta?: TicketMeta;
  readonly issues?: readonly TicketIssue[];
}

export interface TicketHeaderDeps {
  readonly api: DreyPluginApi;
  readonly snapshot: () => BoardSnapshot | null;
  readonly invoke: (method: string, payload?: unknown) => Promise<unknown>;
  readonly onError: (message: string) => void;
  /** The ticket's card (E13-6, boards 9a, 7b, 7c, 7j). */
  readonly strip: TicketStrip;
}

export interface TicketHeader {
  readonly view: FrontmatterViewContrib;
  /** Repaints every open header from the latest board snapshot (phase, repos, issues). */
  repaint(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls !== undefined) {
    node.className = cls;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
};

/** The surface shows a ticket of the board (its vault, or the store's checkout vault). */
const showsTicket = (snapshot: BoardSnapshot | null, context: EditorSurfaceContext): boolean =>
  showsTicketDocument(snapshot, context.vaultId(), context.path());

export function createTicketHeader(deps: TicketHeaderDeps): TicketHeader {
  // Parsed frontmatter by its text: a header drawn again after its own edit
  // (or a tab switch) paints at once instead of waiting for main.
  const models = new Map<string, HeaderModel>();
  const remember = (frontmatter: string, model: HeaderModel): void => {
    models.delete(frontmatter);
    models.set(frontmatter, model);
    if (models.size > 64) {
      models.delete(models.keys().next().value as string);
    }
  };
  const live = new Set<{ node: HTMLElement; paint: () => void }>();

  const view: FrontmatterViewContrib = {
    matches: (context) => showsTicket(deps.snapshot(), context),
    render: (input) => renderHeader(input, input.path ?? ''),
  };

  function renderHeader(input: FrontmatterViewInput, path: string): HTMLElement {
    const root = el('div', 'tickets-head');
    const title = el('input', 'tickets-head-title');
    title.type = 'text';
    title.spellcheck = true;
    title.setAttribute('aria-label', deps.api.i18n.t('ticket.card.title_label'));

    let model: HeaderModel | null = models.get(input.frontmatter) ?? null;
    if (model === null) {
      // Until main answers: what the board read from disk.
      const card = cardOfDocument(deps.snapshot(), path);
      if (card !== null) {
        model = { meta: card.meta, issues: card.issues };
      }
      void (deps.invoke('header', { path, frontmatter: input.frontmatter }) as Promise<HeaderReply>).then((reply) => {
        if (reply.ok && reply.meta !== undefined) {
          model = { meta: reply.meta, issues: reply.issues ?? [] };
          remember(input.frontmatter, model);
          paint();
        }
      });
    }

    const apply = async (patch: Record<string, string | readonly string[]>): Promise<void> => {
      const before = input.frontmatter;
      let reply: HeaderReply;
      try {
        reply = (await deps.invoke('headerEdit', { path, frontmatter: before, patch })) as HeaderReply;
      } catch (error) {
        deps.onError(error instanceof Error ? error.message : String(error));
        paint();
        return;
      }
      if (!reply.ok || reply.frontmatter === undefined || reply.meta === undefined) {
        deps.onError(reply.error ?? 'the ticket header could not be changed');
        paint();
        return;
      }
      if (input.view.state.sliceDoc(0, before.length) !== before) {
        deps.onError('The frontmatter changed in the meantime — try again');
        paint();
        return;
      }
      remember(reply.frontmatter, { meta: reply.meta, issues: reply.issues ?? [] });
      input.view.dispatch({
        changes: { from: 0, to: before.length, insert: reply.frontmatter },
        userEvent: 'input.ticket-header',
      });
    };

    function paint(): void {
      const meta = model?.meta ?? null;
      if (document.activeElement !== title) {
        title.value = meta?.title ?? '';
      }
      // A body that opens with its own `# h1` carries the headline (board 9a shows one, not two).
      title.hidden = bodyOpensWithHeading(input.view.state.doc.toString());
      strip.paint();
    }

    // The headline commits on Enter or when it is left; Escape restores it.
    title.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        title.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        title.value = model?.meta.title ?? '';
        input.view.focus();
      }
    });
    title.addEventListener('blur', () => {
      const typed = title.value.replace(/\s+/g, ' ').trim();
      if (typed === '' || typed === (model?.meta.title ?? '')) {
        title.value = model?.meta.title ?? '';
        return;
      }
      void apply({ title: typed });
    });

    const strip = deps.strip.mount({ path, view: input.view, meta: () => model?.meta ?? null, issues: () => model?.issues ?? [], expandRaw: () => input.expandRaw() });
    root.append(strip.node, title);
    paint();
    const entry = { node: root, paint };
    live.add(entry);
    return root;
  }

  return {
    view,
    repaint: () => {
      for (const entry of [...live]) {
        if (entry.node.isConnected) {
          entry.paint();
        } else {
          live.delete(entry);
        }
      }
    },
  };
}

/**
 * The Log fold: the first time a ticket shows in this session its `## Log`
 * section folds (a long log buries Description and Plan); the owner opens
 * it with the fold marker and it stays as they left it.
 */
export function ticketLogFold(
  api: DreyPluginApi,
  snapshot: () => BoardSnapshot | null,
): (context: EditorSurfaceContext) => unknown {
  const folded = new Set<string>();
  const { ViewPlugin } = api.editor.cm.view;
  const { foldEffect } = api.editor.cm.language;
  return (context) =>
    ViewPlugin.define((view) => {
      const consider = (): void => {
        if (!showsTicket(snapshot(), context) || view.state.doc.length === 0) {
          return;
        }
        const path = context.path() ?? '';
        const key = `${context.vaultId() ?? ''}:${path}`;
        if (folded.has(key)) {
          return;
        }
        // On a tab switch the text and the path arrive one after the other:
        // fold only when the text is this ticket's.
        const text = view.state.doc.toString();
        const id = ticketIdOfText(text);
        const range = logSectionRange(text);
        if (range === null || id === undefined || (ticketIdOfPath(path) !== id && !path.endsWith(`/${id}.md`))) {
          return;
        }
        folded.add(key);
        // Not inside an update: dispatch on the next tick.
        queueMicrotask(() => view.dispatch({ effects: foldEffect.of(range) }));
      };
      consider();
      // Every update, not only text changes: the path can arrive after the
      // text (the surface then nudges the editor with an empty transaction).
      return { update: () => consider() };
    });
}
