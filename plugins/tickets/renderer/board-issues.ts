/**
 * The board's own findings (req-66): what the validator reports about
 * pipeline.md, repos.md and order.md. A bubble in the board toolbar —
 * icon and count, coloured by the worst level, the full summary in its
 * tooltip — unfolds the messages under the row, and each message that
 * names a meta file opens it.
 */
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import type { TicketIssue } from '../shared/tickets';

type IssueLevel = TicketIssue['level'];

const LEVEL_ORDER: readonly IssueLevel[] = ['error', 'warning', 'noise'];

/** The chip's text and colour: the count, and the worst level among them. */
export function issueSummary(issues: readonly TicketIssue[]): { text: string; worst: IssueLevel } | null {
  if (issues.length === 0) {
    return null;
  }
  const worst = LEVEL_ORDER.find((level) => issues.some((i) => i.level === level)) ?? 'noise';
  return { text: `${issues.length} board issue${issues.length === 1 ? '' : 's'}`, worst };
}

/** Worst first, the validator's order inside a level. */
export function sortedIssues(issues: readonly TicketIssue[]): TicketIssue[] {
  return [...issues].sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));
}

/** The meta file a message is about (`order.md: …`, `pipeline.md has …`), as a vault path. */
export function issueMetaFile(message: string): string | null {
  const match = /\b(pipeline|order|repos)\.md\b/.exec(message);
  return match === null ? null : `tickets/_meta/${match[1]}.md`;
}

const LEVEL_LABEL: Record<IssueLevel, string> = {
  error: 'Error',
  warning: 'Warning',
  noise: 'Note',
};

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

export interface BoardIssuesDeps {
  readonly api: DreyPluginApi;
  readonly issues: readonly TicketIssue[];
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly openFile: (path: string) => void;
}

/** The toolbar chip; null without findings. */
export function boardIssuesChip(deps: BoardIssuesDeps): HTMLButtonElement | null {
  const summary = issueSummary(deps.issues);
  if (summary === null) {
    return null;
  }
  const chip = el('button', `tickets-issues-chip tickets-issues-chip-${summary.worst}`);
  chip.type = 'button';
  chip.title = deps.open ? `${summary.text} — hide` : `${summary.text} — show`;
  chip.setAttribute('aria-label', summary.text);
  chip.setAttribute('aria-expanded', String(deps.open));
  chip.append(
    deps.api.ui.icon(summary.worst === 'noise' ? 'info' : 'triangle-alert', 12),
    document.createTextNode(String(deps.issues.length)),
    deps.api.ui.icon('chevron-down', 12),
  );
  if (deps.open) {
    chip.classList.add('tickets-issues-chip-open');
  }
  chip.addEventListener('click', deps.onToggle);
  return chip;
}

/** The unfolded list under the toolbar; null while folded or without findings. */
export function boardIssuesList(deps: BoardIssuesDeps): HTMLElement | null {
  if (!deps.open || deps.issues.length === 0) {
    return null;
  }
  const list = el('ul', 'tickets-issues-list');
  for (const issue of sortedIssues(deps.issues)) {
    const row = el('li', `tickets-issues-item tickets-issues-item-${issue.level}`);
    row.append(el('span', 'tickets-issues-level', LEVEL_LABEL[issue.level]));
    row.append(el('span', 'tickets-issues-message', issue.message));
    const file = issueMetaFile(issue.message);
    if (file !== null) {
      const open = el('button', 'tickets-issues-open', 'Open');
      open.type = 'button';
      open.title = `Open ${file}`;
      open.addEventListener('click', () => deps.openFile(file));
      row.append(open);
    }
    list.append(row);
  }
  return list;
}
