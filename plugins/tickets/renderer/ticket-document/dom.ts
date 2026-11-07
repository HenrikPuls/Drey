// i18n: catalog
/**
 * The ticket document's plain-DOM halves (E13-6, boards 9a, 7b, 7j): the card
 * on top of the document, the proof and the cost by phase. Pure functions of
 * the view models in `model.ts`; every effect (open a picture, open the
 * thread) arrives as a callback so the module knows no IPC and no editor.
 */
import type { I18n } from '../../../../shared/i18n/types';
import type { CostTableView, FlowItem, PageShape, PillTone, ProofView } from './model';
import { assetUrl, offsetWords } from './model';
import { personaPictureNode } from '../team/persona-picture';

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

export interface ProofDeps {
  readonly i18n: I18n;
  readonly vaultId: string | null;
  /** Opens a vault file (a screenshot) in the editor. */
  readonly openFile: (path: string) => void;
}

/** A picture of the proof that cannot be read shows its caption alone. */
function shotImage(deps: ProofDeps, file: string, caption: string): HTMLImageElement {
  const image = el('img');
  image.src = assetUrl(deps.vaultId, `tickets/attachments/${file}`);
  image.alt = caption;
  image.loading = 'lazy';
  image.addEventListener('error', () => image.remove());
  return image;
}

/** The `PROOF` block of board 7j: verdict, checks, one row of tiles (the pictures and the video). */
export function proofNode(deps: ProofDeps, proof: ProofView): HTMLElement {
  const { i18n } = deps;
  const root = el('section', 'tickets-doc-proof');
  root.contentEditable = 'false';
  root.append(el('div', 'tickets-doc-kicker', i18n.t('ticket.proof.kicker')));

  const verdict = el('div', `tickets-doc-verdict-box ${proof.allPassed ? 'is-green' : 'is-red'}`);
  verdict.append(el('b', 'tickets-doc-verdict', proof.summary));
  if (proof.stamp !== '') {
    verdict.append(document.createTextNode(` ${proof.stamp}`));
  }
  root.append(verdict);

  let player: HTMLVideoElement | null = null;
  const tiles = el('div', 'tickets-doc-shots');
  for (const shot of proof.shots) {
    const tile = el('button', 'tickets-doc-shot');
    tile.type = 'button';
    tile.title = i18n.t('ticket.proof.open_named', { name: shot.caption });
    tile.append(shotImage(deps, shot.file, shot.caption), el('span', 'tickets-doc-shot-caption', shot.caption));
    tile.addEventListener('click', () => deps.openFile(`tickets/attachments/${shot.file}`));
    tiles.append(tile);
  }
  if (proof.video !== null && proof.video.file !== null) {
    const tile = el('div', 'tickets-doc-shot is-video');
    player = el('video', 'tickets-doc-player');
    player.preload = 'metadata';
    player.src = assetUrl(deps.vaultId, `tickets/videos/${proof.video.file}`);
    player.setAttribute('aria-label', i18n.t('ticket.proof.walkthrough'));
    const video = player;
    const chapters = proof.video.chapters.length;
    const caption = el('span', 'tickets-doc-shot-caption', i18n.t('ticket.proof.video_chapters', { n: chapters }));
    video.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(video.duration)) {
        caption.textContent = i18n.t('ticket.proof.video_length', { length: offsetWords(video.duration * 1000), n: chapters });
      }
    });
    tile.addEventListener('click', () => {
      video.controls = true;
      caption.remove();
    });
    tile.append(video, caption);
    tiles.append(tile);
  }

  if (proof.checks.length > 0) {
    const list = el('ul', 'tickets-doc-checks');
    for (const check of proof.checks) {
      const row = el('li', `tickets-doc-check ${check.passed ? 'is-pass' : 'is-fail'}`);
      row.append(el('span', 'tickets-doc-mark', check.passed ? '✓' : '✗'), el('span', 'tickets-doc-check-label', check.label));
      const meta = [check.note, check.at].filter((part): part is string => part !== null && part !== '').join(' · ');
      if (meta !== '') {
        const stamp = el('span', 'tickets-doc-check-meta', meta);
        const chapter = proof.video?.chapters.find((entry) => entry.label === check.label);
        if (chapter !== undefined && player !== null) {
          const video = player;
          stamp.classList.add('is-jump');
          stamp.title = i18n.t('ticket.proof.jump', { at: chapter.at });
          stamp.addEventListener('click', () => {
            video.currentTime = chapter.atMs / 1000;
            void video.play().catch(() => undefined);
          });
        }
        row.append(stamp);
      }
      list.append(row);
    }
    root.append(list);
  }
  if (tiles.childElementCount > 0) {
    root.append(tiles);
  }

  if (proof.video !== null && proof.video.file === null) {
    root.append(el('p', 'tickets-doc-note', proof.video.notKept ?? ''));
  }

  if (proof.findings.length > 0) {
    const findings = el('div', 'tickets-doc-findings');
    findings.append(el('div', 'tickets-doc-kicker', i18n.t('ticket.proof.findings')));
    const list = el('ul');
    for (const finding of proof.findings) {
      list.append(el('li', undefined, finding));
    }
    findings.append(list);
    root.append(findings);
  }
  return root;
}

const minutesTotal = (i18n: I18n, table: CostTableView): string => {
  const known = table.rows.filter((row) => row.minutes !== null);
  return known.length === 0 ? table.total.time : i18n.t('ticket.cost.minutes', { n: known.reduce((sum, row) => sum + (row.minutes ?? 0), 0) });
};

/**
 * The cost by phase (req-98, board 7j): Phase · Model · Tokens · Time · Cost,
 * one row per run, a quiet `no run yet` row for a phase still to pass, the
 * total under them. The kicker says the total.
 */
export function costNode(i18n: I18n, table: CostTableView): HTMLElement {
  const root = el('section', 'tickets-doc-cost');
  root.contentEditable = 'false';
  const kicker = el('div', 'tickets-doc-kicker', `${i18n.t('ticket.cost.kicker')} · `);
  kicker.append(el('span', 'tickets-doc-kicker-amount', table.total.cost));
  kicker.append(document.createTextNode(` ${i18n.t('cost.in_total')}`));
  root.append(kicker);

  const grid = el('div', 'tickets-doc-table');
  grid.setAttribute('role', 'table');
  grid.setAttribute('aria-label', i18n.t('cost.table.label'));
  const head = el('div', 'tickets-doc-table-row is-head');
  head.setAttribute('role', 'row');
  for (const [key, cls] of [
    ['cost.table.phase', ''],
    ['cost.table.model', ''],
    ['cost.table.tokens', ''],
    ['cost.table.time', ''],
    ['cost.table.cost', 'is-right'],
  ] as const) {
    const cell = el('span', cls === '' ? undefined : cls, i18n.t(key));
    cell.setAttribute('role', 'columnheader');
    head.append(cell);
  }
  grid.append(head);
  for (const row of table.rows) {
    const line = el('div', `tickets-doc-table-row${row.pending ? ' is-pending' : ''}${row.bad ? ' is-bad' : ''}`);
    line.setAttribute('role', 'row');
    if (row.pending) {
      line.append(el('span', undefined, row.phase), el('span', 'is-muted is-span', i18n.t('cost.table.no_run')));
    } else {
      line.append(
        el('span', undefined, row.persona === '' ? row.phase : `${row.phase} · ${row.persona}`),
        el('span', 'is-muted', row.modelName),
        el('span', 'is-muted is-mono', row.tokens),
        el('span', 'is-muted is-mono', row.minutes === null ? row.time : i18n.t('ticket.cost.minutes', { n: row.minutes })),
        el('span', 'is-muted is-mono is-cost is-right', row.cost),
      );
    }
    grid.append(line);
  }
  const total = el('div', 'tickets-doc-table-row is-total');
  total.setAttribute('role', 'row');
  total.append(
    el('span', undefined, i18n.t('cost.table.total')),
    el('span'),
    el('span', 'is-mono is-cost', table.total.tokens),
    el('span', 'is-mono is-cost', minutesTotal(i18n, table)),
    el('span', 'is-muted is-mono is-cost is-right', table.total.cost),
  );
  grid.append(total);
  root.append(grid);
  return root;
}

// --- going to the decision card ------------------------------------------------

/** The DOM event of "Decision waiting · go to the card": `detail.id` names the ticket (req-97). */
export const GO_TO_DECISION_CARD = 'drey:tickets-go-to-decision-card';

export interface GoToDecisionCardDetail {
  readonly id: string;
  /** A card that is on screen sets it; still false after dispatch = no card is showing. */
  handled: boolean;
}

/**
 * Asks the decision card of the ticket to take the focus. Returns whether a
 * card answered (the Ready card of the thread does, `ready-view.ts`).
 */
export function goToDecisionCard(id: string): boolean {
  const detail: GoToDecisionCardDetail = { id, handled: false };
  document.dispatchEvent(new CustomEvent<GoToDecisionCardDetail>(GO_TO_DECISION_CARD, { detail }));
  return detail.handled;
}

/**
 * The quiet link "Decision waiting · go to the card ›": the decision is made on
 * the Mission Control card only (req-97, canvas decisions 16, 28). With no card
 * on screen it runs `fallback` (the thread, where the Ready card sits) first.
 */
export function decisionLinkNode(i18n: I18n, id: string, fallback: () => void): HTMLAnchorElement {
  const link = el('a', 'tickets-doc-decision-link', `${i18n.t('decision.waiting_go_to_card')} ›`);
  link.href = '#';
  link.addEventListener('click', (event) => {
    event.preventDefault();
    if (!goToDecisionCard(id)) {
      fallback();
      setTimeout(() => goToDecisionCard(id), 300);
    }
  });
  return link;
}

// --- the card -----------------------------------------------------------------

export interface CardFacts {
  readonly shape: PageShape;
  readonly id: string;
  readonly pill: { readonly label: string; readonly tone: PillTone };
  /** The word for why the owner is wanted beside a generic pill; '' when none. */
  readonly kind: string;
  /** The ticket's validator findings as a badge; null when it has none. */
  readonly issues: { readonly count: number; readonly worst: string; readonly title: string } | null;
  readonly flow: readonly FlowItem[];
  /** 9a: `Normal`. */
  readonly priority: string;
  /** Row 7: the persona's name; 9a: the runner. */
  readonly worker: string;
  /** 9a: the grey words after the runner (`· default`). */
  readonly workerNote: string;
  /** 7b: the persona as a picture; null = the name alone. */
  readonly avatar: { readonly color: string; readonly name: string } | null;
  readonly repo: string;
  readonly branch: string;
  /** `$1.84 in total · est. $1.50–2.40 · from 3 runs`; '' while nothing is known. */
  readonly cost: string;
  /** Why the ticket waits on the owner; '' when it does not. */
  readonly gate: string;
  /** A decision waits: the link to the card is shown. */
  readonly decide: boolean;
  /** The Review tab's button: only when the ticket has changes to review. */
  readonly canReview: boolean;
}

export interface CardActions {
  readonly i18n: I18n;
  readonly onThread: () => void;
  readonly onReview: () => void;
  readonly onFlow?: () => void;
  /** The escape to the raw YAML, under the pointer only; absent = no button. */
  readonly onRaw?: () => void;
  readonly icon?: (name: string, size?: number) => SVGElement;
}

/** The pill of a ticket's state (boards 9a, 7b, 7c, 7j, 7d). */
export function pillNode(label: string, tone: PillTone, extraClass = ''): HTMLElement {
  const pill = el('span', `tickets-doc-status is-${tone}${extraClass === '' ? '' : ` ${extraClass}`}`);
  pill.append(el('span', 'tickets-doc-status-dot'), document.createTextNode(label));
  return pill;
}

function buttonNode(label: string, title: string | null, run: () => void): HTMLButtonElement {
  const button = el('button', 'tickets-doc-btn', label);
  button.type = 'button';
  if (title !== null) {
    button.title = title;
  }
  button.addEventListener('click', run);
  return button;
}

function changeLink(actions: CardActions): HTMLElement | null {
  if (actions.onFlow === undefined) {
    return null;
  }
  const change = el('button', 'tickets-doc-flow', actions.i18n.t('ticket.card.change'));
  change.type = 'button';
  change.title = actions.i18n.t('ticket.card.change_hint');
  change.addEventListener('click', actions.onFlow);
  return change;
}

/** Row 7's Flow row: `✓ Shape · Plan (waits for you) · Build`. */
function flowRow(items: readonly FlowItem[]): HTMLElement {
  const row = el('ol', 'tickets-doc-chain');
  items.forEach((item, index) => {
    if (index > 0) {
      row.append(el('li', 'tickets-doc-sep', '·'));
    }
    const step = el('li', `tickets-doc-step is-${item.state}${item.skipped ? ' is-skipped' : ''}`);
    step.append(el('span', 'tickets-doc-step-title', item.state === 'past' ? `✓ ${item.title}` : item.title));
    row.append(step);
    if (item.note !== null) {
      row.append(el('li', 'tickets-doc-step-note', item.note));
    }
  });
  return row;
}

/** The persona's picture, the Crew cards' drawing (fidelity ruling O8). */
export function avatarNode(color: string, title: string, size: number): HTMLElement {
  const avatar = el('span', 'tickets-doc-avatar');
  avatar.title = title;
  avatar.style.setProperty('--avatar-size', `${size}px`);
  avatar.append(personaPictureNode(color, title, size));
  return avatar;
}

/** The ticket card: id, the state once, the actions and one quiet grid (boards 9a, 7b, 7c, 7j). */
export function cardNode(actions: CardActions, facts: CardFacts): HTMLElement {
  const { i18n } = actions;
  const root = el('section', `tickets-doc-strip tickets-card is-${facts.shape}`);
  root.setAttribute('aria-label', i18n.t('ticket.card.label'));

  const top = el('div', 'tickets-card-top');
  top.append(el('span', 'tickets-head-id', facts.id));
  const pill = pillNode(facts.pill.label, facts.pill.tone, 'tickets-head-phase');
  pill.title = i18n.t('ticket.card.phase_hint');
  top.append(pill);
  if (facts.kind !== '') {
    top.append(el('span', 'tickets-doc-kind', facts.kind));
  }
  if (facts.issues !== null) {
    const badge = el('span', `tickets-issues tickets-issues-${facts.issues.worst}`, String(facts.issues.count));
    badge.title = facts.issues.title;
    top.append(badge);
  }
  if (facts.decide) {
    top.append(decisionLinkNode(i18n, facts.id, actions.onThread));
  }
  top.append(el('span', 'tickets-card-spacer'));
  if (actions.onRaw !== undefined && actions.icon !== undefined) {
    const raw = el('button', 'icon-btn tickets-head-raw');
    raw.type = 'button';
    raw.title = i18n.t('ticket.card.raw');
    raw.setAttribute('aria-label', raw.title);
    raw.append(actions.icon('code', 14));
    raw.addEventListener('click', actions.onRaw);
    top.append(raw);
  }
  if (facts.canReview) {
    top.append(buttonNode(i18n.t('ticket.card.open_review'), i18n.t('ticket.card.open_review_hint'), actions.onReview));
  }
  top.append(buttonNode(i18n.t('ticket.card.thread'), i18n.t('ticket.card.thread_hint'), actions.onThread));
  root.append(top);

  const grid = el('div', 'tickets-card-grid');
  const label = (text: string): HTMLElement => el('span', 'tickets-card-label', text);
  if (facts.shape === 'early') {
    const flow = el('span', 'tickets-card-value');
    flow.append(document.createTextNode(facts.flow.map((item) => item.title).join(' → ')));
    const change = changeLink(actions);
    if (change !== null) {
      flow.append(' ', change);
    }
    const worker = el('span', 'tickets-card-value is-control', facts.worker);
    if (facts.workerNote !== '') {
      worker.append(' ', el('span', 'tickets-card-muted', facts.workerNote));
    }
    const repo = el('span', 'tickets-card-value', facts.repo);
    if (facts.branch !== '') {
      repo.append(' ', el('span', 'tickets-card-branch', facts.branch));
    }
    grid.append(
      label(i18n.t('ticket.card.priority')),
      el('span', 'tickets-card-value is-control', facts.priority),
      label(i18n.t('ticket.card.worker')),
      worker,
      label(i18n.t('ticket.card.flow')),
      flow,
      label(i18n.t('ticket.card.repo')),
      repo,
    );
  } else {
    const flow = flowRow(facts.flow);
    flow.classList.add('tickets-card-wide');
    const change = changeLink(actions);
    if (change !== null) {
      change.classList.add('is-hover-only');
      const item = el('li');
      item.append(change);
      flow.append(item);
    }
    grid.append(label(i18n.t('ticket.card.flow')), flow);
    grid.append(label(i18n.t('ticket.card.worker')));
    const worker = el('span', 'tickets-card-value tickets-card-wide');
    if (facts.avatar !== null) {
      worker.append(avatarNode(facts.avatar.color, facts.avatar.name, 24));
    } else {
      worker.textContent = facts.worker;
    }
    grid.append(worker);
    if (facts.cost !== '') {
      grid.append(label(i18n.t('ticket.card.cost')), el('span', 'tickets-card-muted tickets-card-wide tickets-doc-cost-fact', facts.cost));
    }
  }
  root.append(grid);

  if (facts.gate !== '') {
    root.append(el('p', 'tickets-doc-gate', facts.gate));
  }
  return root;
}

/**
 * The note under a marked block of the plan (E13-9, board 7b): who changed it
 * last. A bar of the same colour runs down the lines it belongs to.
 */
export function shapeMarksNode(marks: { readonly paul: string | null; readonly you: string | null; readonly youDetail: string | null }): HTMLElement {
  const root = el('div', 'tickets-doc-shape-marks');
  root.contentEditable = 'false';
  if (marks.paul !== null) {
    root.classList.add('is-paul');
    root.append(el('span', 'tickets-doc-shape-mark is-paul', marks.paul));
  }
  if (marks.you !== null) {
    root.classList.add('is-you');
    const you = el('span', 'tickets-doc-shape-mark is-you', marks.you);
    if (marks.youDetail !== null) {
      you.title = marks.youDetail;
    }
    root.append(you);
  }
  return root;
}
