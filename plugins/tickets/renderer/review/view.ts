/**
 * The Review tab's body (E13-7, board 7d): the proof of the ticket above,
 * the files of its branch below as numbered patch rows (Changes or Whole
 * file), viewed marks per file, line and range comments that leave with a
 * send-back as the Handover's structured feedback, and the two decisions
 * in the footer. Plain DOM over `ReviewDeps`; the module knows no module
 * state of `index.ts`.
 */
import type { DreyPluginApi } from '../../../../shared/plugin-api/renderer';
import type { ReviewComment } from '../../../../packages/tickets-engine/src/core/review-feedback';
import type { TicketDiff, TicketFileReply } from '../../../../packages/tickets-engine/src/core/worktree-changes';
import type { RunInfo } from '../../../../packages/tickets-engine/src/fleet/protocol';
import type { BoardSnapshot, MutationResult, TicketCard } from '../../shared/tickets';
import { proofNode } from '../ticket-document/dom';
import { actionBarOf, proofOfText, type ProofView } from '../ticket-document/model';
import type { WorkRow } from '../work-groups';
import {
  EMPTY_MARKS,
  checksLineOf,
  commentEnd,
  commentsOfFile,
  fileName,
  filesOf,
  filesSummaryOf,
  loadMarks,
  pruneMarks,
  rangeOf,
  saveMarks,
  statOf,
  withComment,
  withoutComment,
  type MarkStorage,
  type ReviewFile,
  type ReviewMarks,
} from './model';
import { vaultFileOf } from './open-file';
import { commentLabelOf, patchRowsOf, sendBackLabelOf, wholeFileRowsOf, type PatchRow } from './patch';

export interface ReviewDeps {
  readonly api: DreyPluginApi;
  snapshot(): BoardSnapshot | null;
  runs(): readonly RunInfo[];
  invoke(method: string, payload?: unknown): Promise<unknown>;
  subscribe(listener: () => void): () => void;
  mutate(label: string, run: () => Promise<unknown>): Promise<MutationResult>;
  rowOf(card: TicketCard): WorkRow | null;
  /** The plain send-back dialog (a note, no comments). */
  openSendBack(ticketId: string): void;
  /** The ticket's own file in the editor. */
  openTicketFile(card: TicketCard): void;
  /** The card of an archived ticket opened from the Done group (E13-21); absent = none. */
  archivedCard?(ticketId: string): TicketCard | null;
  storage(): MarkStorage | null;
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

/** The composer's target: a new comment (`index` null) or an edit of the one at `index`. */
interface Composer {
  readonly file: string;
  readonly line: number;
  readonly endLine: number | null;
  readonly index: number | null;
  readonly text: string;
}

type ViewMode = 'changes' | 'whole';

export function mountReview(deps: ReviewDeps, host: HTMLElement, ticketId: string): () => void {
  const root = el('div', 'tickets-review');
  host.replaceChildren(root);

  let disposed = false;
  let proof: ProofView | null = null;
  let files: ReviewFile[] = [];
  let truncated = false;
  let loaded = false;
  let loadError: string | null = null;
  let marks: ReviewMarks = loadMarks(deps.storage(), ticketId);
  let selected: string | null = null;
  let mode: ViewMode = 'changes';
  let composer: Composer | null = null;
  let anchor: { file: string; line: number } | null = null;
  let note: { text: string; error: boolean } | null = null;
  let busy = false;
  /** Whole-file texts already fetched, by path; a failed fetch keeps its message. */
  const wholeFiles = new Map<string, TicketFileReply | 'loading'>();

  const card = (): TicketCard | null =>
    deps.snapshot()?.columns.flatMap((column) => column.tickets).find((ticket) => ticket.id === ticketId) ??
    deps.archivedCard?.(ticketId) ??
    null;

  const setMarks = (next: ReviewMarks): void => {
    marks = next;
    saveMarks(deps.storage(), ticketId, marks);
  };

  // --- structure --------------------------------------------------------------

  const head = el('div', 'tickets-review-head');
  const proofHost = el('div', 'tickets-review-proof');
  const filesBar = el('div', 'tickets-review-files');
  const filePane = el('div', 'tickets-review-pane');
  const footer = el('div', 'tickets-review-footer');
  const scroller = el('div', 'tickets-review-scroll');
  scroller.append(head, proofHost, filesBar, filePane);
  root.append(scroller, footer);

  const icon = (name: string, size = 14): SVGElement => deps.api.ui.icon(name, size);

  const button = (label: string, cls: string, glyph: string | null, title: string, run: () => void): HTMLButtonElement => {
    const node = el('button', `tickets-review-btn ${cls}`.trim());
    node.type = 'button';
    node.title = title;
    if (glyph !== null) {
      node.append(icon(glyph));
    }
    if (label !== '') {
      node.append(document.createTextNode(label));
    } else {
      node.setAttribute('aria-label', title);
    }
    node.addEventListener('click', run);
    return node;
  };

  // --- head and proof -----------------------------------------------------------

  const paintHead = (): void => {
    head.replaceChildren();
    const current = card();
    head.append(el('span', 'tickets-review-id', ticketId));
    head.append(el('span', 'tickets-review-title', current?.meta.title ?? ''));
    if (current !== null) {
      head.append(el('span', 'tickets-review-spacer'));
      head.append(button('Ticket', '', 'file-text', 'Open the ticket file', () => deps.openTicketFile(current)));
    }
  };

  const paintProof = (): void => {
    proofHost.replaceChildren();
    if (proof === null) {
      if (loaded) {
        proofHost.append(el('p', 'tickets-review-empty', 'This ticket carries no Verification section.'));
      }
      return;
    }
    const vaultId = deps.snapshot()?.vaultId ?? null;
    proofHost.append(
      proofNode(
        {
          vaultId,
          openFile: (path) => void deps.api.documents.open(path, undefined, vaultId === null ? undefined : { vaultId }),
        },
        proof,
      ),
    );
  };

  // --- files ------------------------------------------------------------------

  const viewedSet = (): ReadonlySet<string> => new Set(marks.viewed);

  const paintFilesBar = (): void => {
    filesBar.replaceChildren();
    if (!loaded || files.length === 0) {
      return;
    }
    const viewed = viewedSet();
    const summary = el('div', 'tickets-review-summary', filesSummaryOf(files, viewed));
    if (truncated) {
      summary.append(el('span', 'tickets-review-trunc', ' · the list is cut for size'));
    }
    filesBar.append(summary);
    const chips = el('div', 'tickets-review-chips');
    for (const file of files) {
      const chip = el('button', 'tickets-review-chip');
      chip.type = 'button';
      chip.title = file.path;
      if (file.path === selected) {
        chip.classList.add('is-selected');
      }
      if (viewed.has(file.key)) {
        chip.classList.add('is-viewed');
      }
      chip.append(
        el('span', 'tickets-review-chip-mark', viewed.has(file.key) ? '✓' : file.status),
        el('span', 'tickets-review-chip-name', file.path),
        el('span', 'tickets-review-chip-stat', statOf(file)),
      );
      const count = marks.comments.filter((comment) => comment.file === file.path).length;
      if (count > 0) {
        chip.append(el('span', 'tickets-review-chip-comments', String(count)));
      }
      chip.addEventListener('click', () => {
        selected = file.path;
        composer = null;
        paintFilesBar();
        paintPane();
      });
      chips.append(chip);
    }
    filesBar.append(chips);
  };

  const rowsOf = (file: ReviewFile): PatchRow[] | 'loading' | string => {
    if (mode === 'changes') {
      return patchRowsOf(file.patch).filter((row) => row.kind !== 'meta');
    }
    const whole = wholeFiles.get(file.path);
    if (whole === undefined) {
      wholeFiles.set(file.path, 'loading');
      void deps
        .invoke('reviewFile', { id: ticketId, path: file.path })
        .then((reply) => wholeFiles.set(file.path, reply as TicketFileReply))
        .catch((error) => wholeFiles.set(file.path, { ok: false, error: error instanceof Error ? error.message : String(error) }))
        .finally(() => {
          if (!disposed) {
            paintPane();
          }
        });
      return 'loading';
    }
    if (whole === 'loading') {
      return 'loading';
    }
    return whole.ok ? wholeFileRowsOf(file.patch, whole.text) : whole.error;
  };

  const openInEditor = async (file: ReviewFile, line: number | null): Promise<void> => {
    const worktree = worktreeOf();
    const vaults = await deps.api.vault.listVaults();
    const target = vaultFileOf(vaults, worktree, file.path);
    if (target !== null) {
      await deps.api.documents.open(target.path, line ?? undefined, { vaultId: target.vaultId });
      return;
    }
    // The branch is not a registered vault: a copy of the file as it stands
    // on the branch opens as a scratch tab instead.
    const reply = (await deps.invoke('reviewFile', { id: ticketId, path: file.path })) as TicketFileReply;
    if (reply.ok) {
      deps.api.documents.openScratch(file.path, reply.text);
      setNote('Opened a copy of the file from the ticket branch. Register its folder as a vault to edit it in place.', false);
    } else {
      setNote(reply.error, true);
    }
  };

  const showHistory = async (file: ReviewFile): Promise<void> => {
    const target = vaultFileOf(await deps.api.vault.listVaults(), worktreeOf(), file.path);
    if (target === null) {
      setNote('Git history needs the file in a registered vault that is a Git repository.', true);
      return;
    }
    await deps.api.documents.open(target.path, undefined, { vaultId: target.vaultId });
    deps.api.commands.run('git.fileHistory');
  };

  const worktreeOf = (): string => {
    let newest: RunInfo | null = null;
    for (const run of deps.runs()) {
      if (run.ticketId === ticketId && run.worktreePath !== '' && (newest === null || run.startedAt > newest.startedAt)) {
        newest = run;
      }
    }
    return newest?.worktreePath ?? '';
  };

  // --- the diff pane ------------------------------------------------------------

  const saveComment = (): void => {
    if (composer === null) {
      return;
    }
    const next = withComment(
      marks.comments,
      { file: composer.file, line: composer.line, endLine: composer.endLine, text: composer.text },
      composer.index,
    );
    if (next === null) {
      return;
    }
    setMarks({ ...marks, comments: next });
    composer = null;
    paintAll();
  };

  const composerNode = (open: Composer): HTMLElement => {
    const box = el('div', 'tickets-review-composer');
    box.append(
      el('div', 'tickets-review-comment-head', `${commentLabelOf(open)} · goes with Send back`),
    );
    const input = el('textarea', 'tickets-review-input');
    input.rows = 2;
    input.value = open.text;
    input.setAttribute('aria-label', 'Comment');
    input.addEventListener('input', () => {
      composer = composer === null ? null : { ...composer, text: input.value };
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        saveComment();
      } else if (event.key === 'Escape') {
        composer = null;
        paintPane();
      }
    });
    const actions = el('div', 'tickets-review-comment-actions');
    actions.append(
      button('Add comment', 'is-primary', null, 'Keep the comment for the send-back (Ctrl+Enter)', saveComment),
      button('Cancel', '', null, 'Discard this comment', () => {
        composer = null;
        paintPane();
      }),
    );
    box.append(input, actions);
    queueMicrotask(() => input.focus());
    return box;
  };

  const commentNode = (comment: ReviewComment, index: number): HTMLElement => {
    const box = el('div', 'tickets-review-comment');
    box.append(el('div', 'tickets-review-comment-head', `You on ${commentLabelOf(comment).toLowerCase()} · goes with Send back`));
    box.append(el('div', 'tickets-review-comment-text', comment.text));
    const actions = el('div', 'tickets-review-comment-actions');
    actions.append(
      button('Edit', '', null, 'Change this comment', () => {
        composer = { file: comment.file, line: comment.line, endLine: comment.endLine, index, text: comment.text };
        paintPane();
      }),
      button('Remove', '', null, 'Drop this comment', () => {
        setMarks({ ...marks, comments: withoutComment(marks.comments, index) });
        paintAll();
      }),
    );
    box.append(actions);
    return box;
  };

  const paintPane = (): void => {
    filePane.replaceChildren();
    if (!loaded) {
      filePane.append(el('p', 'tickets-review-empty', loadError ?? 'Loading the changes…'));
      return;
    }
    const file = files.find((entry) => entry.path === selected) ?? null;
    if (file === null) {
      filePane.append(
        el('p', 'tickets-review-empty', loadError ?? 'The ticket branch has no changes yet — nothing to review in the code.'),
      );
      return;
    }

    const bar = el('div', 'tickets-review-filebar');
    bar.append(el('span', 'tickets-review-filepath', file.path));
    const seg = el('div', 'tickets-review-seg');
    for (const [id, label] of [['changes', 'Changes'], ['whole', 'Whole file']] as const) {
      const choice = button(label, mode === id ? 'is-on' : '', null, id === 'changes' ? 'Only the changed lines' : 'The whole file with the changes in place', () => {
        mode = id;
        composer = null;
        paintPane();
      });
      choice.setAttribute('aria-pressed', String(mode === id));
      seg.append(choice);
    }
    bar.append(seg);
    bar.append(
      button('Open in editor', '', 'external-link', 'Open this file in an editor tab', () => void openInEditor(file, null)),
      button('Git history', '', 'history', "This file's Git history", () => void showHistory(file)),
    );
    const viewed = viewedSet();
    const label = el('label', 'tickets-review-viewed');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = viewed.has(file.key);
    box.addEventListener('change', () => {
      setMarks({
        ...marks,
        viewed: box.checked ? [...new Set([...marks.viewed, file.key])] : marks.viewed.filter((key) => key !== file.key),
      });
      paintFilesBar();
      paintFooter();
      label.classList.toggle('is-on', box.checked);
    });
    label.classList.toggle('is-on', box.checked);
    label.append(box, document.createTextNode('Viewed'));
    bar.append(label);
    filePane.append(bar);

    if (file.binary) {
      filePane.append(el('p', 'tickets-review-empty', 'A binary file — there are no lines to show.'));
      return;
    }
    const rows = rowsOf(file);
    if (rows === 'loading') {
      filePane.append(el('p', 'tickets-review-empty', 'Loading the file…'));
      return;
    }
    if (typeof rows === 'string') {
      filePane.append(el('p', 'tickets-review-empty is-error', rows));
      return;
    }
    if (mode === 'whole') {
      const reply = wholeFiles.get(file.path);
      if (reply !== undefined && reply !== 'loading' && reply.ok && reply.truncated) {
        filePane.append(el('p', 'tickets-review-trunc', 'The file is long; only its beginning is shown.'));
      }
    }

    const table = el('div', 'tickets-review-table');
    table.setAttribute('role', 'table');
    const placed = new Set<number>();
    const fileComments = commentsOfFile(marks.comments, file.path);
    const range = composer !== null && composer.file === file.path ? composer : null;
    for (const row of rows) {
      const line = el('div', `tickets-review-row is-${row.kind}`);
      if (range !== null && row.newNo !== null && row.newNo >= range.line && row.newNo <= (range.endLine ?? range.line)) {
        line.classList.add('is-picked');
      }
      const oldNo = el('span', 'tickets-review-no', row.oldNo === null ? '' : String(row.oldNo));
      const newNo = el('span', 'tickets-review-no');
      if (row.newNo !== null && row.kind !== 'hunk') {
        const add = el('button', 'tickets-review-add');
        add.type = 'button';
        add.textContent = String(row.newNo);
        add.title = 'Comment on this line (Shift-click extends a range)';
        add.setAttribute('aria-label', `Comment on line ${row.newNo}`);
        const at = row.newNo;
        add.addEventListener('click', (event) => {
          const span = event.shiftKey && anchor !== null && anchor.file === file.path ? rangeOf(anchor.line, at) : { line: at, endLine: null };
          if (!event.shiftKey || anchor === null || anchor.file !== file.path) {
            anchor = { file: file.path, line: at };
          }
          composer = { file: file.path, ...span, index: null, text: '' };
          paintPane();
        });
        newNo.append(add);
      }
      const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : '';
      line.append(oldNo, newNo, el('span', 'tickets-review-sign', sign), el('span', 'tickets-review-code', row.text));
      table.append(line);
      if (row.newNo !== null && row.kind !== 'del') {
        for (const { comment, index } of fileComments) {
          if (commentEnd(comment) === row.newNo && !placed.has(index) && !(composer?.index === index)) {
            placed.add(index);
            table.append(commentNode(comment, index));
          }
        }
        if (composer !== null && composer.file === file.path && composer.index === null && (composer.endLine ?? composer.line) === row.newNo) {
          table.append(composerNode(composer));
        } else if (composer !== null && composer.file === file.path && composer.index !== null) {
          const editing = marks.comments[composer.index];
          if (editing !== undefined && commentEnd(editing) === row.newNo) {
            table.append(composerNode(composer));
          }
        }
      }
    }
    filePane.append(table);

    const stray = fileComments.filter(({ index }) => !placed.has(index) && composer?.index !== index);
    if (stray.length > 0) {
      const box = el('div', 'tickets-review-stray');
      box.append(el('div', 'tickets-review-kicker', 'Comments on lines outside this view'));
      for (const { comment, index } of stray) {
        box.append(commentNode(comment, index));
      }
      filePane.append(box);
    }
  };

  // --- footer -------------------------------------------------------------------

  const setNote = (text: string, error: boolean): void => {
    note = { text, error };
    paintFooter();
  };

  const decide = async (kind: 'sendBack' | 'accept'): Promise<void> => {
    const current = card();
    if (current === null || busy) {
      return;
    }
    if (kind === 'sendBack' && marks.comments.length === 0) {
      deps.openSendBack(ticketId);
      return;
    }
    busy = true;
    note = null;
    paintFooter();
    const result =
      kind === 'accept'
        ? await deps.mutate(`Accepting ${ticketId}`, () => deps.invoke('acceptTicket', { id: ticketId }))
        : await deps.mutate(`Sending ${ticketId} back`, () =>
            deps.invoke('sendBack', { id: ticketId, note: '', comments: marks.comments }),
          );
    busy = false;
    if (result.ok) {
      setMarks(EMPTY_MARKS);
      composer = null;
      note = {
        text: kind === 'accept' ? 'Accepted.' : 'Sent back — the comments are in the ticket’s Handover.',
        error: false,
      };
      paintAll();
    } else {
      setNote(result.error ?? 'The change was refused.', true);
    }
  };

  const paintFooter = (): void => {
    footer.replaceChildren();
    const current = card();
    const snapshot = deps.snapshot();
    const left = el('div', 'tickets-review-checks', checksLineOf(proof));
    footer.append(left);
    if (note !== null) {
      footer.append(el('div', `tickets-review-note${note.error ? ' is-error' : ''}`, note.text));
    }
    footer.append(el('span', 'tickets-review-spacer'));
    if (current === null || snapshot === null) {
      return;
    }
    const bar = actionBarOf(deps.rowOf(current), snapshot);
    if (!bar.decide) {
      footer.append(el('span', 'tickets-review-muted', 'Not waiting for your decision'));
      return;
    }
    const count = marks.comments.length;
    const back = button(sendBackLabelOf(count), '', 'corner-down-left', 'Send the ticket back with your comments as feedback', () => void decide('sendBack'));
    const accept = button(bar.acceptLabel, 'is-primary', 'check', 'Accept the result', () => void decide('accept'));
    back.disabled = busy;
    accept.disabled = busy;
    footer.append(back, accept);
  };

  const paintAll = (): void => {
    paintHead();
    paintProof();
    paintFilesBar();
    paintPane();
    paintFooter();
  };

  // --- load ---------------------------------------------------------------------

  const load = async (): Promise<void> => {
    const current = card();
    const vaultId = deps.snapshot()?.vaultId ?? null;
    try {
      if (current !== null && vaultId !== null) {
        const text = (await deps.api.vault.readFile(current.path, { vaultId })).content;
        proof = proofOfText(text);
      }
      const diff = (await deps.invoke('reviewDiff', { id: ticketId })) as TicketDiff;
      files = filesOf(diff);
      truncated = diff.truncated;
      marks = pruneMarks(marks, files);
      if (!files.some((file) => file.path === selected)) {
        selected = files[0]?.path ?? null;
      }
      loadError = null;
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }
    loaded = true;
    if (!disposed) {
      paintAll();
    }
  };

  paintAll();
  void load();
  const off = deps.subscribe(() => {
    if (!disposed) {
      paintHead();
      paintFooter();
    }
  });
  return () => {
    disposed = true;
    off();
    root.remove();
  };
}
