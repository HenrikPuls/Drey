/**
 * The Ready card of the ticket thread (req-75 W3, ADR-0087 decision 3,
 * the canvas `docs/design/work-panel/Ready.dc.html`, artboard "3c"):
 * in plain words what changed for the owner, where, which checks
 * passed and how to try it — Launch this version, Accept and merge,
 * Send back… — plus "How it got here", the ticket's story from its
 * Log. Plain DOM over `shared/changes.ts`; the section is the worker's
 * writing, missing sections are simply left out.
 */
import type { ParsedChanges, StoryItem, StoryTotals } from '../shared/changes';
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
  /** In the terminal phase the Accept button reads just `Accept`. */
  readonly terminal: boolean;
  readonly changes: ParsedChanges | null;
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
 * The Ready card: the canvas header (kicker, title, chips) above a
 * bordered card of sections and the three buttons. A ticket without a
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
  chips.append(el('span', 'tickets-ready-chip tickets-ready-chip-ready', 'Ready to try'));
  head.append(title, chips);

  const body = el('div', 'tickets-ready-body');
  const section = (heading: string): HTMLElement => {
    const node = el('div', 'tickets-ready-section');
    node.append(el('b', undefined, heading));
    body.append(node);
    return node;
  };

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

  const actions = el('div', 'tickets-ready-actions');
  const launch = el('button', 'tickets-takeover-btn tickets-takeover-btn-primary tickets-ready-launch');
  launch.type = 'button';
  launch.title = 'Open the ticket worktree in a new console and start it there';
  launch.append(deps.icon('rocket', 14), el('span', undefined, 'Launch this version'));
  launch.addEventListener('click', deps.onLaunch);
  const accept = el('button', 'tickets-takeover-btn', data.terminal ? 'Accept' : 'Accept and merge');
  accept.type = 'button';
  accept.addEventListener('click', deps.onAccept);
  const sendBack = el('button', 'tickets-takeover-btn tickets-ready-sendback', 'Send back…');
  sendBack.type = 'button';
  sendBack.addEventListener('click', deps.onSendBack);
  actions.append(launch, accept, el('span', 'tickets-takeover-spacer'), sendBack);

  body.append(actions, el('p', 'tickets-ready-hint',
    'Launch opens this ticket\'s worktree in a new console and starts it there. Accept moves the ticket on: in Done it goes to the archive and its worktree is removed; earlier, the next phase merges it.'));

  root.append(head, body);
  return root;
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
