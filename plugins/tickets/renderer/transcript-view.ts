/**
 * The takeover tab's transcript as the plugin's own DOM (req-58): the
 * watch view model (`watch-format.ts`) drawn block by block instead of
 * through the host's Markdown view, which showed tool outcomes as a
 * literal `&nbsp;⎿` and thinking as a heavy callout.
 *
 * - tool calls are compact rows (state dot, name, target relative to the
 *   run's worktree, outcome muted); a run of more than three folds into
 *   one "N tool calls" group, open while it is the live tail;
 * - thinking is a borderless fold with a one-line preview;
 * - replies render a small Markdown subset (`transcript-text.ts`).
 *
 * The 2 s pull hands the whole view again; `update` keeps every item
 * whose content did not change (so an unfolded thought stays unfolded)
 * and follows new output only while the reader sits at the bottom.
 */
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { renderReply } from './transcript-text';
import type { WatchBlock, WatchStep, WatchView } from './watch-format';

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

/** A run of more steps than this folds into one group. */
const GROUP_MIN = 4;

/** How close to the bottom still counts as "following" the output (px). */
const FOLLOW_SLACK = 40;

/** One drawn unit: a single block, or a run of steps. */
export type TranscriptItem =
  | { readonly kind: 'block'; readonly key: string; readonly block: WatchBlock }
  | { readonly kind: 'group'; readonly key: string; readonly steps: readonly WatchBlock[]; readonly tail: boolean };

/** The blocks as drawn units: runs of `GROUP_MIN`+ steps become groups, keyed by their first index. */
export function transcriptItems(blocks: readonly WatchBlock[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i]!;
    if (block.kind !== 'step') {
      items.push({ kind: 'block', key: `b${i}`, block });
      i += 1;
      continue;
    }
    let end = i;
    while (end < blocks.length && blocks[end]!.kind === 'step') {
      end += 1;
    }
    if (end - i >= GROUP_MIN) {
      items.push({ kind: 'group', key: `g${i}`, steps: blocks.slice(i, end), tail: end === blocks.length });
    } else {
      for (let k = i; k < end; k++) {
        items.push({ kind: 'block', key: `b${k}`, block: blocks[k]! });
      }
    }
    i = end;
  }
  return items;
}

/** What makes an item look different — equal signatures keep the drawn node. */
const signature = (item: TranscriptItem): string =>
  item.kind === 'block'
    ? `${item.block.kind}|${item.block.live === true ? 1 : 0}|${item.block.markdown}`
    : `${item.tail ? 1 : 0}|${item.steps.map((s) => `${s.live === true ? 1 : 0}${s.markdown}`).join('\n')}`;

/**
 * A target with the run's worktree prefix taken out (either slash, any
 * case — Windows paths), so `E:\…\_worktrees\T-1\src\a.ts` reads `src\a.ts`.
 */
export function shortenTarget(target: string, worktreePath: string): string {
  const root = worktreePath.replace(/[\\/]+$/, '');
  if (root === '') {
    return target;
  }
  const pattern = root
    .split(/[\\/]+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\\\/]+');
  return target.replace(new RegExp(`${pattern}(?:[\\\\/]+|(?=\\s|$))`, 'gi'), '');
}

/** The transcript handle the takeover tab mounts. */
export interface TranscriptViewHandle {
  readonly element: HTMLElement;
  update(view: WatchView): void;
  setWorktree(path: string): void;
}

export function createTranscriptView(api: DreyPluginApi, worktreePath: string): TranscriptViewHandle {
  const frame = el('div', 'tickets-tx-frame');
  const scroller = el('div', 'tickets-tx');
  const column = el('div', 'tickets-tx-column');
  scroller.append(column);
  const jump = el('button', 'tickets-tx-jump', '↓ New output');
  jump.type = 'button';
  jump.title = 'Scroll to the newest output and follow it';
  jump.hidden = true;
  frame.append(scroller, jump);

  let root = worktreePath;
  let following = true;
  let drawn: { key: string; sig: string; node: HTMLElement }[] = [];
  /** Folds the reader opened or closed by hand, by item key — they win over the defaults. */
  const userOpen = new Map<string, boolean>();

  const atBottom = (): boolean => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= FOLLOW_SLACK;
  const toBottom = (): void => {
    scroller.scrollTop = scroller.scrollHeight;
  };
  scroller.addEventListener('scroll', () => {
    following = atBottom();
    if (following) {
      jump.hidden = true;
    }
  });
  jump.addEventListener('click', () => {
    following = true;
    jump.hidden = true;
    toBottom();
  });

  const fold = (key: string, openByDefault: boolean, summary: HTMLElement, body: HTMLElement, className: string): HTMLElement => {
    const details = el('details', className);
    details.open = userOpen.get(key) ?? openByDefault;
    summary.addEventListener('click', () => {
      userOpen.set(key, !details.open);
    });
    details.append(summary, body);
    return details;
  };

  const stepRow = (block: WatchBlock): HTMLElement => {
    const step: WatchStep = block.step ?? { name: block.tool ?? 'Tool', target: '' };
    const state = block.live === true ? 'running' : step.failed === true ? 'failed' : step.outcome !== undefined ? 'done' : 'called';
    const row = el('div', 'tickets-tx-step');
    row.dataset['state'] = state;
    row.append(el('span', 'tickets-tx-dot'), el('span', 'tickets-tx-tool', step.name));
    if (step.target !== '') {
      const target = el('span', 'tickets-tx-target', shortenTarget(step.target, root));
      target.title = step.target;
      row.append(target);
    }
    if (step.outcome !== undefined && step.outcome !== '') {
      const said = step.failed === true ? `failed: ${step.outcome}` : step.outcome;
      const outcome = el('span', 'tickets-tx-outcome', shortenTarget(said, root));
      outcome.title = said;
      row.append(outcome);
    } else if (state === 'running') {
      row.append(el('span', 'tickets-tx-outcome', 'running…'));
    }
    return row;
  };

  const groupNode = (item: Extract<TranscriptItem, { kind: 'group' }>): HTMLElement => {
    const summary = el('summary', 'tickets-tx-group-head');
    const failed = item.steps.filter((s) => s.step?.failed === true).length;
    summary.append(
      el('span', 'tickets-tx-chevron', '›'),
      el('span', 'tickets-tx-group-count', `${item.steps.length} tool calls`),
    );
    if (failed > 0) {
      summary.append(el('span', 'tickets-tx-group-failed', `${failed} failed`));
    }
    const last = item.steps[item.steps.length - 1]?.step;
    if (last !== undefined) {
      summary.append(el('span', 'tickets-tx-group-last', `${last.name} ${shortenTarget(last.target, root)}`.trim()));
    }
    const body = el('div', 'tickets-tx-group-body');
    for (const step of item.steps) {
      body.append(stepRow(step));
    }
    return fold(item.key, item.tail, summary, body, 'tickets-tx-group');
  };

  const blockNode = (key: string, block: WatchBlock): HTMLElement => {
    switch (block.kind) {
      case 'step':
        return stepRow(block);
      case 'thinking': {
        const thought = block.thought ?? '';
        const summary = el('summary', 'tickets-tx-think-head');
        summary.append(
          el('span', 'tickets-tx-chevron', '›'),
          el('span', 'tickets-tx-think-label', 'Thinking'),
          el('span', 'tickets-tx-think-preview', thought.replace(/\s+/g, ' ').trim()),
        );
        return fold(key, false, summary, el('div', 'tickets-tx-think-body', thought), 'tickets-tx-think');
      }
      case 'you': {
        const row = el('div', 'tickets-tx-you');
        row.append(el('div', 'tickets-tx-you-bubble', block.text ?? block.markdown));
        return row;
      }
      case 'setup':
        return el('div', 'tickets-tx-setup', block.text ?? block.markdown);
      case 'result': {
        const node = el('div', 'tickets-tx-result');
        const rule = el('div', 'tickets-tx-result-rule');
        rule.append(el('span', 'tickets-tx-result-chip', '✓ Turn finished'));
        node.append(rule);
        if (block.text !== undefined) {
          node.append(renderReply(api, block.text));
        }
        return node;
      }
      case 'error': {
        const node = el('div', 'tickets-tx-error');
        node.append(el('span', 'tickets-tx-error-label', 'Error'), el('span', undefined, block.text ?? block.markdown));
        return node;
      }
      default: {
        const node = renderReply(api, block.markdown);
        if (block.live === true) {
          node.classList.add('tickets-tx-live');
        }
        return node;
      }
    }
  };

  const update = (view: WatchView): void => {
    const follow = following || atBottom();
    const items = transcriptItems(view.blocks);
    const next: typeof drawn = [];
    let changed = false;
    items.forEach((item, index) => {
      const sig = signature(item);
      const old = drawn[index];
      if (old !== undefined && old.key === item.key && old.sig === sig) {
        next.push(old);
        return;
      }
      changed = true;
      const node = item.kind === 'group' ? groupNode(item) : blockNode(item.key, item.block);
      if (old !== undefined) {
        old.node.replaceWith(node);
      } else {
        column.append(node);
      }
      next.push({ key: item.key, sig, node });
    });
    for (const stale of drawn.slice(items.length)) {
      stale.node.remove();
      changed = true;
    }
    drawn = next;
    if (items.length === 0 && column.childElementCount === 0) {
      column.append(el('div', 'tickets-tx-empty', 'The stream is empty so far.'));
    } else if (items.length > 0) {
      column.querySelector(':scope > .tickets-tx-empty')?.remove();
    }
    if (!changed) {
      return;
    }
    if (follow) {
      following = true;
      toBottom();
    } else {
      jump.hidden = false;
    }
  };

  return {
    element: frame,
    update,
    setWorktree: (path: string): void => {
      root = path;
    },
  };
}
