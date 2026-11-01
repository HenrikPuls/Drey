/**
 * The Ready card of the ticket thread (req-75 W3, ADR-0087 decision 3,
 * the canvas `docs/design/work-panel/Ready.dc.html`, artboard "3c"):
 * in plain words what changed for the owner, where, which checks
 * passed and how to try it — Launch this version, the move on,
 * Send back… — plus "How it got here", the ticket's story from its
 * Log. Plain DOM over `shared/changes.ts`; the section is the worker's
 * writing, missing sections are simply left out.
 */
import type { ParsedChanges, StoryItem, StoryTotals } from '../shared/changes';
import type { StepCard } from '../shared/step-card';
import type { TicketTrack } from '../shared/tickets';
import { formatTokens } from './worker-status';

/** What the card's buttons do (the thread wires them to its IPC seams). */
export interface ReadyViewDeps {
  onLaunch(): void;
  onAccept(): void;
  onSendBack(): void;
  /** The host's glyph seam (`api.ui.icon`) — plugins draw no SVG of their own. */
  icon(name: string, size?: number): SVGElement;
}

/** The card's data: the ticket's chips plus the parsed `## Changes`. */
export interface ReadyData {
  readonly id: string;
  readonly title: string | null;
  readonly track: TicketTrack | null;
  readonly repo: string | null;
  /** Which card this is and what it offers (`stepCardOf`): a gate or the final report. */
  readonly card: StepCard;
  readonly changes: ParsedChanges | null;
  /** The commit step's `## Result` report — the final card's lead section. */
  readonly result: string | null;
}

/** The story column's data. */
export interface StoryData {
  readonly story: readonly StoryItem[];
  readonly totals: StoryTotals;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/** The worker's fixed closing line, shown muted under the text (canvas). */
const NOTHING_ELSE = 'Nothing else you can see has changed.';

/**
 * The step card: the canvas header (kicker, title, chips) above a
 * bordered card of sections and the buttons — a gate's (launch, move on,
 * send back) or the final report's (archive). A ticket without a
 * `## Changes` section still gets the header, the buttons and the hint.
 */
export function readyCardNode(deps: ReadyViewDeps, data: ReadyData): HTMLElement {
  const root = el('div', 'tickets-ready-card');

  const head = el('div', 'tickets-ready-head');
  head.append(el('span', 'tickets-ready-kicker', data.id));
  const title = el('h1', 'tickets-ready-title', data.title ?? '(untitled)');
  const chips = el('div', 'tickets-ready-chips');
  if (data.track !== null) {
    chips.append(el('span', 'tickets-ready-chip tickets-ready-chip-track', data.track === 'auto' ? 'Auto track' : 'Shape track'));
  }
  if (data.repo !== null) {
    chips.append(el('span', 'tickets-ready-chip', data.repo));
  }
  const final = data.card.kind === 'final';
  chips.append(
    el('span', `tickets-ready-chip ${final ? 'tickets-ready-chip-done' : 'tickets-ready-chip-ready'}`, final ? 'Done' : 'Needs your decision'),
  );
  head.append(title, chips);

  const body = el('div', 'tickets-ready-body');
  const section = (heading: string): HTMLElement => {
    const node = el('div', 'tickets-ready-section');
    node.append(el('b', undefined, heading));
    body.append(node);
    return node;
  };

  if (final && data.result !== null) {
    const node = section('What was delivered');
    node.append(el('p', 'tickets-ready-for-you', data.result));
  }

  const changes = data.changes;
  if (changes !== null) {
    if (changes.forYou !== null) {
      const node = section('What changed for you');
      const lines = changes.forYou.split('\n');
      const muted = lines[lines.length - 1] === NOTHING_ELSE ? lines.pop()! : null;
      node.append(el('p', 'tickets-ready-for-you', lines.join('\n')));
      if (muted !== null) {
        node.append(el('p', 'tickets-ready-muted', muted));
      }
    }
    if (changes.files.length > 0) {
      const node = section('Where');
      for (const file of changes.files) {
        const row = el('div', 'tickets-ready-file');
        row.append(el('span', `tickets-ready-status tickets-ready-status-${file.status}`, file.status));
        row.append(el('span', 'tickets-ready-path', file.path));
        row.append(el('span', 'tickets-ready-why', file.why));
        node.append(row);
      }
    }
    if (changes.checks.length > 0) {
      const node = section('Checks');
      for (const check of changes.checks) {
        const line = el('div', 'tickets-ready-check');
        line.append(el('span', 'tickets-ready-tick', '✓'), el('span', undefined, check));
        node.append(line);
      }
    }
    if (changes.howToTry !== null) {
      section('How to try it').append(el('p', 'tickets-ready-for-you', changes.howToTry));
    }
  }

  body.append(readyActionsNode(deps, data.card), el('p', 'tickets-ready-hint', hintOf(data.card)));

  root.append(head, body);
  return root;
}

function hintOf(card: StepCard): string {
  if (card.kind === 'final') {
    return 'This step is finished and merged. Archive files the ticket away and removes its clean worktree.';
  }
  return `${card.canLaunch ? 'Launch opens this ticket\'s worktree in a new console and starts it there. ' : ''}${card.acceptLabel} moves the ticket on; Send back returns it to the agent with your note.`;
}

/** The card's buttons: Launch (when a build can run), the primary move, Send back. */
export function readyActionsNode(deps: ReadyViewDeps, card: StepCard): HTMLElement {
  const actions = el('div', 'tickets-ready-actions');
  if (card.canLaunch) {
    const launch = el('button', 'tickets-takeover-btn tickets-takeover-btn-primary tickets-ready-launch');
    launch.type = 'button';
    launch.title = 'Open the ticket worktree in a new console and start it there';
    launch.append(deps.icon('rocket', 14), el('span', undefined, 'Launch this version'));
    launch.addEventListener('click', deps.onLaunch);
    actions.append(launch);
  }
  const accept = el(
    'button',
    `tickets-takeover-btn${card.canLaunch ? '' : ' tickets-takeover-btn-primary'}`,
    card.acceptLabel,
  );
  accept.type = 'button';
  accept.addEventListener('click', deps.onAccept);
  actions.append(accept, el('span', 'tickets-takeover-spacer'));
  if (card.canSendBack) {
    const sendBack = el('button', 'tickets-takeover-btn tickets-ready-sendback', 'Send back…');
    sendBack.type = 'button';
    sendBack.addEventListener('click', deps.onSendBack);
    actions.append(sendBack);
  }
  return actions;
}

/**
 * The strip above the card: a fold toggle, the ticket and the card's
 * state — and, while folded, the card's buttons, so the gate stays
 * decidable with the agent log given the whole height.
 */
export function readyBarNode(
  deps: ReadyViewDeps,
  data: ReadyData,
  state: { readonly open: boolean; onToggle(): void },
): HTMLElement {
  const bar = el('div', 'tickets-ready-bar');
  const toggle = el('button', 'icon-btn tickets-ready-fold');
  toggle.type = 'button';
  toggle.title = state.open ? 'Fold the card away' : 'Unfold the card';
  toggle.setAttribute('aria-label', toggle.title);
  toggle.setAttribute('aria-expanded', String(state.open));
  toggle.append(deps.icon(state.open ? 'chevron-down' : 'chevron-right', 14));
  toggle.addEventListener('click', state.onToggle);
  const final = data.card.kind === 'final';
  bar.append(
    toggle,
    el('span', 'tickets-ready-bar-id', data.id),
    el('span', 'tickets-ready-bar-title', data.title ?? '(untitled)'),
    el('span', `tickets-ready-chip ${final ? 'tickets-ready-chip-done' : 'tickets-ready-chip-ready'}`, final ? 'Done' : 'Needs your decision'),
  );
  if (!state.open) {
    bar.append(el('span', 'tickets-takeover-spacer'), readyActionsNode(deps, data.card));
  }
  return bar;
}

/** "How it got here": the story rows and the muted totals line. */
export function storyNode(data: StoryData): HTMLElement {
  const root = el('aside', 'tickets-story');
  root.append(el('b', 'tickets-story-head', 'How it got here'));
  for (const item of data.story) {
    const row = el('div', 'tickets-story-row');
    const at = el('span', 'tickets-story-at', item.at);
    const what = el('span', 'tickets-story-what');
    what.append(el('span', undefined, item.what), el('span', 'tickets-story-who', item.who));
    row.append(at, what);
    root.append(row);
  }
  if (data.totals.minutes !== null || data.totals.tokens !== null) {
    const parts = [
      data.totals.minutes !== null ? `Total ${data.totals.minutes} min` : null,
      data.totals.tokens !== null ? `${formatTokens(data.totals.tokens)} tokens` : null,
    ].filter((part): part is string => part !== null);
    root.append(el('span', 'tickets-story-total', parts.join(' · ')));
  }
  return root;
}
