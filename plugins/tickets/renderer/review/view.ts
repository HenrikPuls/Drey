// i18n: catalog
/**
 * The Review tab's body (E13-7, board 7d): head, the proof band, then the file
 * list and the diff (Changes or Whole file), side by side under a splitter
 * (E12-19). Viewed marks per file; line and range comments leave with a
 * send-back as the Handover's structured feedback. The decision is the Mission
 * Control card's (canvas decision 28): the tab links to it and hands it the
 * comments through two document events (`events.ts`). Plain DOM over `ReviewDeps`.
 */
import type { DreyPluginApi } from '../../../../shared/plugin-api/renderer';
import type { ReviewComment } from '../../../../packages/tickets-engine/src/core/review-feedback';
import type { TicketDiff, TicketFileReply } from '../../../../packages/tickets-engine/src/core/worktree-changes';
import { parseVerlaufEntries } from '../../../../packages/tickets-engine/src/core/verlauf';
import type { RunInfo } from '../../../../packages/tickets-engine/src/fleet/protocol';
import type { BoardSnapshot, MutationResult, TicketCard } from '../../shared/tickets';
import { decisionLinkNode, pillNode } from '../ticket-document/dom';
import { actionBarOf, assetUrl, offsetWords, proofOfText, titleCase, type ProofView } from '../ticket-document/model';
import type { WorkRow } from '../work-groups';
import { REVIEW_SEND_BACK, announceReviewComments, type ReviewSendBackDetail } from './events';
import {
  EMPTY_MARKS,
  clampSplit,
  commentEnd,
  commentsOfFile,
  filesOf,
  goalOfText,
  loadMarks,
  loadSplit,
  pruneMarks,
  rangeOf,
  saveMarks,
  saveSplit,
  statOf,
  withComment,
  withoutComment,
  type MarkStorage,
  type ReviewFile,
  type ReviewMarks,
  type ReviewSplit,
} from './model';
import { vaultFileOf } from './open-file';
import { patchRowsOf, wholeFileRowsOf, type PatchRow } from './patch';

export interface ReviewDeps {
  readonly api: DreyPluginApi;
  snapshot(): BoardSnapshot | null;
  runs(): readonly RunInfo[];
  invoke(method: string, payload?: unknown): Promise<unknown>;
  subscribe(listener: () => void): () => void;
  mutate(label: string, run: () => Promise<unknown>): Promise<MutationResult>;
  rowOf(card: TicketCard): WorkRow | null;
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
  const { i18n } = deps.api;
  const root = el('div', 'tickets-review');
  host.replaceChildren(root);

  let disposed = false;
  let proof: ProofView | null = null;
  let ticketText = '';
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
  let split: ReviewSplit = loadSplit(deps.storage());
  /** Whole-file texts already fetched, by path; a failed fetch keeps its message. */
  const wholeFiles = new Map<string, TicketFileReply | 'loading'>();

  const card = (): TicketCard | null =>
    deps.snapshot()?.columns.flatMap((column) => column.tickets).find((ticket) => ticket.id === ticketId) ??
    deps.archivedCard?.(ticketId) ??
    null;

  const setMarks = (next: ReviewMarks): void => {
    marks = next;
    saveMarks(deps.storage(), ticketId, marks);
    announceReviewComments(ticketId, marks.comments.length);
  };

  // --- structure --------------------------------------------------------------

  const head = el('div', 'tickets-review-head');
  const proofHost = el('div', 'tickets-review-proof');
  const filesRow = el('div', 'tickets-review-work');
  const list = el('div', 'tickets-review-list');
  const filePane = el('div', 'tickets-review-pane');

  const icon = (name: string, size = 14): SVGElement => deps.api.ui.icon(name, size);

  const button = (label: string, cls: string, title: string, run: () => void): HTMLButtonElement => {
    const node = el('button', `tickets-review-btn ${cls}`.trim(), label);
    node.type = 'button';
    node.title = title;
    node.addEventListener('click', run);
    return node;
  };

  /** A line the pointer drags (E12-19); arrow keys move it too. Its size is kept per machine. */
  const splitter = (axis: 'proof' | 'list', label: string): HTMLElement => {
    const handle = el('div', `tickets-review-split is-${axis}`);
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', axis === 'proof' ? 'horizontal' : 'vertical');
    handle.setAttribute('aria-label', label);
    handle.tabIndex = 0;
    const set = (value: number): void => {
      split = { ...split, [axis]: clampSplit(axis, value) };
      applySplit();
      saveSplit(deps.storage(), split);
    };
    const current = (): number => (axis === 'proof' ? proofHost.getBoundingClientRect().height : list.getBoundingClientRect().width);
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const start = axis === 'proof' ? event.clientY : event.clientX;
      const from = current();
      handle.setPointerCapture(event.pointerId);
      const move = (next: PointerEvent): void => set(from + (axis === 'proof' ? next.clientY : next.clientX) - start);
      const up = (): void => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
    handle.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 16 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -16 : 0;
      if (step !== 0) {
        event.preventDefault();
        set(current() + step);
      }
    });
    return handle;
  };

  const applySplit = (): void => {
    proofHost.style.height = split.proof === null ? '' : `${split.proof}px`;
    list.style.width = `${split.list}px`;
  };

  filesRow.append(list, splitter('list', i18n.t('review.resize_files')), filePane);
  root.append(head, proofHost, splitter('proof', i18n.t('review.resize_proof')), filesRow);
  applySplit();

  // --- head ---------------------------------------------------------------------

  /** Who built what the tab shows: the Log of runs names them. */
  const builderOf = (): string => {
    const entries = parseVerlaufEntries(ticketText);
    const built = [...entries].reverse().find((entry) => entry.phase === 'build' && (entry.persona ?? '') !== '') ?? [...entries].reverse().find((entry) => (entry.persona ?? '') !== '');
    return built?.persona === undefined || built.persona === null ? '' : titleCase(built.persona);
  };

  const paintHead = (): void => {
    head.replaceChildren();
    const current = card();
    const snapshot = deps.snapshot();
    const row = el('div', 'tickets-review-head-row');
    row.append(el('span', 'tickets-review-id', ticketId), el('b', 'tickets-review-title', current?.meta.title ?? ''));
    if (current !== null && snapshot !== null && actionBarOf(deps.rowOf(current), snapshot).decide) {
      row.append(pillNode(i18n.t('review.needs_review'), 'peach', 'is-review'), decisionLinkNode(i18n, ticketId, () => undefined));
    }
    head.append(row);
    const who = builderOf();
    const goal = goalOfText(ticketText);
    if (who !== '') {
      const line = goal === '' ? i18n.t('review.sub_plain', { who }) : i18n.t('review.sub', { goal, who });
      const sub = el('div', 'tickets-review-sub', line);
      sub.title = line;
      head.append(sub);
    }
  };

  // --- the proof band -------------------------------------------------------------

  const paintProof = (): void => {
    proofHost.replaceChildren();
    if (proof === null) {
      if (loaded) {
        proofHost.append(el('p', 'tickets-review-empty', i18n.t('review.no_verification')));
      }
      return;
    }
    const vaultId = deps.snapshot()?.vaultId ?? null;
    const video = proof.video?.file ?? null;
    let player: HTMLVideoElement | null = null;
    if (video !== null) {
      const tile = el('div', 'tickets-review-video');
      player = el('video', 'tickets-review-player');
      const running = player;
      running.preload = 'metadata';
      running.src = assetUrl(vaultId, `tickets/videos/${video}`);
      running.setAttribute('aria-label', i18n.t('ticket.proof.walkthrough'));
      const duration = el('span', 'tickets-review-video-time');
      running.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(running.duration)) {
          duration.textContent = offsetWords(running.duration * 1000);
        }
      });
      const play = el('button', 'tickets-review-play');
      play.type = 'button';
      play.title = i18n.t('review.play');
      play.setAttribute('aria-label', play.title);
      play.append(icon('play', 28));
      play.addEventListener('click', () => {
        running.controls = true;
        play.remove();
        void running.play().catch(() => undefined);
      });
      tile.append(running, play, duration);
      proofHost.append(tile);
    }

    const body = el('div', 'tickets-review-proof-body');
    const title = el('div', 'tickets-review-subhead');
    title.append(el('span', 'tickets-review-subhead-title', i18n.t('review.proof')));
    const chapters = proof.video?.chapters ?? [];
    title.append(
      el('span', 'tickets-review-subhead-note', video === null ? i18n.t('review.tested_by', { who: proof.tester }) : i18n.t('review.walkthrough', { who: proof.tester, n: chapters.length })),
    );
    body.append(title);

    const passed = proof.checks.filter((check) => check.passed).length;
    const verdict = el('div', `tickets-review-verdict ${proof.allPassed ? 'is-green' : 'is-red'}`);
    const fact = (ok: boolean, build: (node: HTMLElement) => void, hint?: string): void => {
      const node = el('span', 'tickets-review-fact');
      if (hint !== undefined) {
        node.title = hint;
      }
      const mark = el('span', `tickets-review-fact-mark ${ok ? 'is-ok' : 'is-bad'}`);
      mark.append(icon(ok ? 'check' : 'x', 14));
      node.append(mark);
      build(node);
      verdict.append(node);
    };
    fact(proof.allPassed, (node) => {
      node.append(el('b', 'tickets-review-count', `${passed}/${proof!.checks.length}`), document.createTextNode(i18n.t('review.checks')));
    }, proof.stamp);
    fact(true, (node) => node.append(document.createTextNode(i18n.t('review.tested_by', { who: proof!.tester }))), proof.stamp);
    let spent = 0;
    for (const entry of parseVerlaufEntries(ticketText)) {
      if (typeof entry.cost === 'number' && Number.isFinite(entry.cost) && entry.cost > 0) {
        spent += entry.cost;
      }
    }
    if (spent > 0) {
      const cost = el('span', 'tickets-review-cost', `${i18n.t('review.cost')} `);
      cost.append(el('span', 'tickets-review-cost-amount', i18n.formatCurrency(spent)));
      verdict.append(cost);
    }
    body.append(verdict);

    if (chapters.length > 0) {
      const strip = el('div', 'tickets-review-chapters');
      chapters.forEach((chapter, index) => {
        const chip = el('button', `tickets-review-chapter${index === 0 ? ' is-first' : ''}`, `${chapter.at} ${chapter.label}`);
        chip.type = 'button';
        chip.title = i18n.t('ticket.proof.jump', { at: chapter.at });
        chip.addEventListener('click', () => {
          if (player !== null) {
            player.currentTime = chapter.atMs / 1000;
            player.controls = true;
            void player.play().catch(() => undefined);
          }
        });
        strip.append(chip);
      });
      body.append(strip);
    }

    if (proof.shots.length > 0) {
      const thumbs = el('div', 'tickets-review-thumbs');
      for (const shot of proof.shots) {
        const path = `tickets/attachments/${shot.file}`;
        const thumb = el('button', 'tickets-review-thumb');
        thumb.type = 'button';
        thumb.title = i18n.t('ticket.proof.open_named', { name: shot.caption });
        const image = el('img');
        image.src = assetUrl(vaultId, path);
        image.alt = shot.caption;
        image.loading = 'lazy';
        image.addEventListener('error', () => image.remove());
        thumb.append(image, el('span', 'tickets-review-thumb-caption', shot.caption));
        thumb.addEventListener('click', () => void deps.api.documents.open(path, undefined, vaultId === null ? undefined : { vaultId }));
        thumbs.append(thumb);
      }
      body.append(thumbs);
    }
    proofHost.append(body);
  };

  // --- the file list --------------------------------------------------------------

  const viewedSet = (): ReadonlySet<string> => new Set(marks.viewed);

  const paintList = (): void => {
    list.replaceChildren();
    const viewed = viewedSet();
    const subhead = el('div', 'tickets-review-subhead has-line');
    subhead.append(el('span', 'tickets-review-subhead-title', i18n.t('review.files')));
    const seen = files.filter((file) => viewed.has(file.key)).length;
    if (loaded && files.length > 0) {
      const count = el('span', 'tickets-review-subhead-note tickets-review-summary', i18n.t('review.files_viewed', { seen, total: files.length }));
      if (truncated) {
        count.title = i18n.t('review.cut_for_size');
      }
      subhead.append(count);
    }
    // Interim until 4.8 draws the Send back option on the decision card (build plan row 4.8).
    const current = card();
    const snapshot = deps.snapshot();
    if (marks.comments.length > 0 && current !== null && snapshot !== null && actionBarOf(deps.rowOf(current), snapshot).decide) {
      const back = button(i18n.t('decision.send_back_with_comments', { n: marks.comments.length }), 'tickets-review-sendback', i18n.t('review.send_back_hint'), () => void sendBackWithComments());
      back.disabled = busy;
      subhead.append(back);
    }
    list.append(subhead);
    const rows = el('div', 'tickets-review-list-rows');
    for (const file of files) {
      const row = el('div', `tickets-review-file${file.path === selected ? ' is-selected' : ''}`);
      row.title = file.path;
      const box = el('input', 'tickets-review-viewed');
      box.type = 'checkbox';
      box.checked = viewed.has(file.key);
      box.setAttribute('aria-label', i18n.t('review.mark_viewed', { path: file.path }));
      box.addEventListener('click', (event) => event.stopPropagation());
      box.addEventListener('change', () => {
        setMarks({
          ...marks,
          viewed: box.checked ? [...new Set([...marks.viewed, file.key])] : marks.viewed.filter((key) => key !== file.key),
        });
        paintList();
      });
      const name = el('div', 'tickets-review-file-text');
      name.append(el('div', 'tickets-review-file-path', file.path), el('div', 'tickets-review-file-stat', statOf(file)));
      row.append(box, name);
      row.addEventListener('click', () => {
        selected = file.path;
        composer = null;
        paintList();
        paintPane();
      });
      rows.append(row);
    }
    list.append(rows);
    if (note !== null) {
      list.append(el('div', `tickets-review-note${note.error ? ' is-error' : ''}`, note.text));
    }
  };

  const rowsOf = (file: ReviewFile): PatchRow[] | 'loading' | string => {
    if (mode === 'changes') {
      // The first hunk's `@@` line says nothing the numbers don't; later ones mark the jump.
      const rows = patchRowsOf(file.patch).filter((row) => row.kind !== 'meta');
      return rows[0]?.kind === 'hunk' ? rows.slice(1) : rows;
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
      setNote(i18n.t('review.copy_opened'), false);
    } else {
      setNote(reply.error, true);
    }
  };

  const showHistory = async (file: ReviewFile): Promise<void> => {
    const target = vaultFileOf(await deps.api.vault.listVaults(), worktreeOf(), file.path);
    if (target === null) {
      setNote(i18n.t('review.git_needs_vault'), true);
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
    paintList();
    paintPane();
  };

  const whereOf = (comment: { line: number; endLine: number | null }): string =>
    comment.endLine === null ? i18n.t('review.comment_line', { line: comment.line }) : i18n.t('review.comment_lines', { line: comment.line, end: comment.endLine });

  const commentHead = (comment: { line: number; endLine: number | null }): HTMLElement => {
    const row = el('div', 'tickets-review-comment-head');
    row.append(el('b', undefined, i18n.t('review.comment_you')), el('span', 'tickets-review-comment-where', whereOf(comment)));
    return row;
  };

  const composerNode = (open: Composer): HTMLElement => {
    const box = el('div', 'tickets-review-composer');
    box.append(commentHead(open));
    const input = el('textarea', 'tickets-review-input');
    input.rows = 2;
    input.value = open.text;
    input.setAttribute('aria-label', i18n.t('review.comment_label'));
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
      button(i18n.t('review.comment_add'), 'is-primary', i18n.t('review.comment_add_hint'), saveComment),
      button(i18n.t('review.comment_cancel'), '', i18n.t('review.comment_cancel_hint'), () => {
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
    const top = commentHead(comment);
    const remove = el('button', 'tickets-review-comment-delete');
    remove.type = 'button';
    remove.title = i18n.t('review.comment_delete');
    remove.setAttribute('aria-label', remove.title);
    remove.append(icon('trash-2', 13));
    remove.addEventListener('click', () => {
      setMarks({ ...marks, comments: withoutComment(marks.comments, index) });
      paintList();
      paintPane();
    });
    top.append(el('span', 'tickets-review-spacer'), remove);
    box.append(top);
    const text = el('div', 'tickets-review-comment-text', comment.text);
    text.title = i18n.t('review.comment_edit');
    text.addEventListener('click', () => {
      composer = { file: comment.file, line: comment.line, endLine: comment.endLine, index, text: comment.text };
      paintPane();
    });
    box.append(text);
    return box;
  };

  const paintPane = (): void => {
    filePane.replaceChildren();
    if (!loaded) {
      filePane.append(el('p', 'tickets-review-empty', loadError ?? i18n.t('review.loading_changes')));
      return;
    }
    const file = files.find((entry) => entry.path === selected) ?? null;
    if (file === null) {
      filePane.append(el('p', 'tickets-review-empty', loadError ?? i18n.t('review.no_changes')));
      return;
    }

    const bar = el('div', 'tickets-review-filebar');
    const path = el('span', 'tickets-review-filepath', file.path);
    path.title = file.path;
    bar.append(path, el('span', 'tickets-review-spacer'));
    const seg = el('div', 'tickets-review-seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', i18n.t('review.view_label'));
    for (const id of ['changes', 'whole'] as const) {
      const choice = el('button', `tickets-review-seg-btn${mode === id ? ' is-on' : ''}`, i18n.t(id === 'changes' ? 'review.changes' : 'review.whole_file'));
      choice.type = 'button';
      choice.title = i18n.t(id === 'changes' ? 'review.changes_hint' : 'review.whole_file_hint');
      choice.setAttribute('aria-pressed', String(mode === id));
      choice.addEventListener('click', () => {
        mode = id;
        composer = null;
        paintPane();
      });
      seg.append(choice);
    }
    bar.append(
      seg,
      button(i18n.t('review.open_in_editor'), '', i18n.t('review.open_in_editor_hint'), () => void openInEditor(file, null)),
      button(i18n.t('review.git_history'), '', i18n.t('review.git_history_hint'), () => void showHistory(file)),
    );
    filePane.append(bar);

    const scroll = el('div', 'tickets-review-diff');
    filePane.append(scroll);
    if (file.binary) {
      scroll.append(el('p', 'tickets-review-empty', i18n.t('review.binary')));
      return;
    }
    const rows = rowsOf(file);
    if (rows === 'loading') {
      scroll.append(el('p', 'tickets-review-empty', i18n.t('review.loading_file')));
      return;
    }
    if (typeof rows === 'string') {
      scroll.append(el('p', 'tickets-review-empty is-error', rows));
      return;
    }
    if (mode === 'whole') {
      const reply = wholeFiles.get(file.path);
      if (reply !== undefined && reply !== 'loading' && reply.ok && reply.truncated) {
        scroll.append(el('p', 'tickets-review-empty', i18n.t('review.file_long')));
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
        add.title = i18n.t('review.comment_line_hint');
        add.setAttribute('aria-label', i18n.t('review.comment_on_line', { n: row.newNo }));
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
    scroll.append(table);

    const stray = fileComments.filter(({ index }) => !placed.has(index) && composer?.index !== index);
    if (stray.length > 0) {
      const box = el('div', 'tickets-review-stray');
      box.append(el('div', 'tickets-review-kicker', i18n.t('review.comments_outside')));
      for (const { comment, index } of stray) {
        box.append(commentNode(comment, index));
      }
      scroll.append(box);
    }
  };

  // --- sending back -----------------------------------------------------------------

  const setNote = (text: string, error: boolean): void => {
    note = { text, error };
    paintList();
  };

  /** Send back with the line comments; the one Accept lives on the decision card (req-97). */
  const sendBackWithComments = async (): Promise<void> => {
    const ticket = card();
    if (ticket === null || busy || marks.comments.length === 0) {
      return;
    }
    busy = true;
    note = null;
    paintList();
    const result = await deps.mutate(`Sending ${ticketId} back`, () =>
      deps.invoke('sendBack', { id: ticketId, note: '', comments: marks.comments }),
    );
    busy = false;
    if (result.ok) {
      setMarks(EMPTY_MARKS);
      composer = null;
      note = { text: i18n.t('review.sent_back'), error: false };
      paintAll();
    } else {
      setNote(result.error ?? i18n.t('review.refused'), true);
    }
  };

  const onSendBack = (event: Event): void => {
    const detail = (event as CustomEvent<ReviewSendBackDetail>).detail;
    if (detail.id === ticketId) {
      detail.handled = true;
      void sendBackWithComments();
    }
  };
  document.addEventListener(REVIEW_SEND_BACK, onSendBack);

  const paintAll = (): void => {
    paintHead();
    paintProof();
    paintList();
    paintPane();
  };

  // --- load ---------------------------------------------------------------------

  /** The ticket's text: a store ticket's document lies in the checkout, its card's path names no file (D-23). */
  const readTicket = async (current: TicketCard): Promise<string> => {
    const located = (await deps.invoke('ticketDocument', { id: ticketId })) as { ok?: boolean; document?: { vaultId: string; path: string } | null } | null;
    if (located?.ok === true && located.document != null) {
      return (await deps.api.vault.readFile(located.document.path, { vaultId: located.document.vaultId })).content;
    }
    const vaultId = deps.snapshot()?.vaultId ?? null;
    return vaultId === null ? '' : (await deps.api.vault.readFile(current.path, { vaultId })).content;
  };

  const load = async (): Promise<void> => {
    const current = card();
    try {
      if (current !== null) {
        ticketText = await readTicket(current);
        proof = proofOfText(i18n, ticketText);
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
      announceReviewComments(ticketId, marks.comments.length);
    }
  };

  paintAll();
  void load();
  const off = deps.subscribe(() => {
    if (!disposed) {
      paintHead();
    }
  });
  return () => {
    disposed = true;
    off();
    document.removeEventListener(REVIEW_SEND_BACK, onSendBack);
    root.remove();
  };
}
