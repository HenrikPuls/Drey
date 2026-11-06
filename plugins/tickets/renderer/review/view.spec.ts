// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DreyPluginApi } from '../../../../shared/plugin-api/renderer';
import type { BoardSnapshot, TicketCard } from '../../shared/tickets';
import type { WorkRow } from '../work-groups';
import { GO_TO_DECISION_CARD } from '../ticket-document/dom';
import { ticketIdOfKey } from './register';
import { mountReview, type ReviewDeps } from './view';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const PATCH_A = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,3 +1,4 @@', ' one', '-two', '+TWO', '+two and a half', ' three'].join('\n');
const PATCH_B = ['@@ -0,0 +1,1 @@', '+hello'].join('\n');

const card = { id: 'T-0121', path: 'tickets/ready/T-0121.md', phase: 'ready', meta: { title: 'Outline drag' } } as unknown as TicketCard;
const snapshot = {
  vaultId: 'v1',
  pipeline: [],
  columns: [
    { phase: { id: 'ready', title: 'Ready' }, tickets: [card] },
    { phase: { id: 'commit', title: 'Commit' }, tickets: [] },
  ],
} as unknown as BoardSnapshot;
const waiting = { card: { id: 'T-0121' }, phase: { id: 'ready' }, need: { kind: 'checkpoint' } } as unknown as WorkRow;

function setup(overrides: Partial<ReviewDeps> = {}, vaults: { id: string; path: string }[] = []) {
  const calls: { method: string; payload: unknown }[] = [];
  const store = new Map<string, string>();
  const opened: unknown[][] = [];
  const api = {
    ui: { icon: () => document.createElementNS('http://www.w3.org/2000/svg', 'svg') },
    vault: {
      readFile: async () => ({ content: '# T-0121\n', modifiedMs: 0 }),
      listVaults: async () => vaults,
    },
    documents: {
      open: async (...args: unknown[]) => void opened.push(args),
      openScratch: vi.fn(),
    },
    commands: { run: vi.fn() },
  } as unknown as DreyPluginApi;
  const deps: ReviewDeps = {
    api,
    snapshot: () => snapshot,
    runs: () => [],
    invoke: async (method, payload) => {
      calls.push({ method, payload });
      if (method === 'reviewDiff') {
        return {
          truncated: false,
          files: [
            { status: 'M', path: 'src/a.ts', patch: PATCH_A },
            { status: 'A', path: 'src/b.ts', patch: PATCH_B },
          ],
        };
      }
      if (method === 'reviewFile') {
        return { ok: true, text: 'one\nTWO\ntwo and a half\nthree\nfour\n', truncated: false };
      }
      return { ok: true };
    },
    subscribe: () => () => undefined,
    mutate: async (_label, run) => (await run()) as { ok: true },
    rowOf: () => waiting,
    openSendBack: vi.fn(),
    openTicketFile: vi.fn(),
    storage: () => ({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) }),
    ...overrides,
  };
  const host = document.createElement('div');
  document.body.append(host);
  const dispose = mountReview(deps, host, 'T-0121');
  return { host, deps, calls, store, opened, dispose };
}

const click = (node: Element | null | undefined, init: MouseEventInit = {}): void => {
  if (!node) {
    throw new Error('nothing to click');
  }
  node.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }));
};
const byText = (host: HTMLElement, selector: string, text: string): HTMLElement | undefined =>
  [...host.querySelectorAll<HTMLElement>(selector)].find((node) => node.textContent?.includes(text));

describe('ticketIdOfKey', () => {
  it('reads the ticket id out of the tab key', () => {
    expect(ticketIdOfKey('review://T-0121')).toBe('T-0121');
    expect(ticketIdOfKey('thread://ticket')).toBeNull();
    expect(ticketIdOfKey('review://nonsense')).toBeNull();
  });
});

describe('Review tab', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('lists the files with the viewed count and shows the first file’s rows', async () => {
    const { host } = setup();
    await flush();
    expect(host.querySelector('.tickets-review-summary')?.textContent).toBe('2 files · 0 of 2 viewed');
    expect(host.querySelectorAll('.tickets-review-chip')).toHaveLength(2);
    expect(host.querySelector('.tickets-review-filepath')?.textContent).toBe('src/a.ts');
    const added = [...host.querySelectorAll('.tickets-review-row.is-add .tickets-review-code')].map((n) => n.textContent);
    expect(added).toEqual(['TWO', 'two and a half']);
    expect(host.textContent).toContain('This ticket carries no Verification section.');
  });

  it('marks a file viewed and keeps the mark', async () => {
    const { host, store } = setup();
    await flush();
    const box = host.querySelector<HTMLInputElement>('.tickets-review-viewed input')!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(host.querySelector('.tickets-review-summary')?.textContent).toBe('2 files · 1 of 2 viewed');
    expect(JSON.parse(store.get('drey.tickets.review.T-0121')!).viewed).toHaveLength(1);
  });

  it('turns a click on a line number into a comment that goes with Send back as structured feedback', async () => {
    const { host, calls } = setup();
    await flush();
    const numbers = [...host.querySelectorAll<HTMLButtonElement>('.tickets-review-add')];
    click(numbers.find((n) => n.textContent === '2'));
    const input = host.querySelector<HTMLTextAreaElement>('.tickets-review-input')!;
    input.value = 'Name this after what it returns.';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    expect(host.querySelector('.tickets-review-comment-text')?.textContent).toBe('Name this after what it returns.');
    const send = byText(host, '.tickets-review-footer .tickets-review-btn', 'Send back')!;
    expect(send.textContent).toBe('Send back with 1 comment');
    click(send);
    await flush();
    const sent = calls.find((c) => c.method === 'sendBack')!;
    expect(sent.payload).toEqual({
      id: 'T-0121',
      note: '',
      comments: [{ file: 'src/a.ts', line: 2, endLine: null, text: 'Name this after what it returns.' }],
    });
    expect(host.querySelector('.tickets-review-comment')).toBeNull();
    expect(host.querySelector('.tickets-review-note')?.textContent).toContain('Sent back');
  });

  it('extends a range with shift-click, in either direction', async () => {
    const { host, calls } = setup();
    await flush();
    const at = (n: string): HTMLButtonElement =>
      [...host.querySelectorAll<HTMLButtonElement>('.tickets-review-add')].find((b) => b.textContent === n)!;
    click(at('3'));
    click(at('1'), { shiftKey: true });
    const input = host.querySelector<HTMLTextAreaElement>('.tickets-review-input')!;
    input.value = 'Whole block.';
    input.dispatchEvent(new Event('input'));
    click(byText(host, '.tickets-review-btn', 'Add comment'));
    click(byText(host, '.tickets-review-footer .tickets-review-btn', 'Send back'));
    await flush();
    expect((calls.find((c) => c.method === 'sendBack')!.payload as { comments: unknown[] }).comments).toEqual([
      { file: 'src/a.ts', line: 1, endLine: 3, text: 'Whole block.' },
    ]);
  });

  it('offers no Send back without comments (that decision is on the card)', async () => {
    const { host, calls } = setup();
    await flush();
    expect(byText(host, '.tickets-review-footer .tickets-review-btn', 'Send back')).toBeUndefined();
    expect(calls.some((c) => c.method === 'sendBack')).toBe(false);
  });

  it('carries no Accept, only the link "Decision waiting · go to the card" (req-97)', async () => {
    const { host, calls } = setup();
    await flush();
    const footer = host.querySelector('.tickets-review-footer')!;
    expect(footer.textContent).not.toContain('Accept');
    const link = footer.querySelector<HTMLAnchorElement>('.tickets-review-decision-link')!;
    expect(link.textContent).toBe('Decision waiting · go to the card');
    const heard: string[] = [];
    const listener = (event: Event): void => {
      heard.push((event as CustomEvent<{ id: string }>).detail.id);
    };
    document.addEventListener(GO_TO_DECISION_CARD, listener);
    link.click();
    document.removeEventListener(GO_TO_DECISION_CARD, listener);
    expect(heard).toEqual(['T-0121']);
    expect(calls.some((c) => c.method === 'acceptTicket')).toBe(false);
  });

  it('shows no decision buttons while the ticket does not wait for the owner', async () => {
    const { host } = setup({ rowOf: () => null });
    await flush();
    expect(host.querySelector('.tickets-review-footer')?.textContent).toContain('Not waiting for your decision');
    expect(byText(host, '.tickets-review-footer .tickets-review-btn', 'Accept')).toBeUndefined();
  });

  it('switches to Whole file and fetches the file once', async () => {
    const { host, calls } = setup();
    await flush();
    click(byText(host, '.tickets-review-seg .tickets-review-btn', 'Whole file'));
    await flush();
    const codes = [...host.querySelectorAll('.tickets-review-row .tickets-review-code')].map((n) => n.textContent);
    expect(codes).toEqual(['one', 'two', 'TWO', 'two and a half', 'three', 'four']);
    expect(calls.filter((c) => c.method === 'reviewFile')).toHaveLength(1);
  });

  it('opens the file as a vault file at the line when the worktree is a registered vault', async () => {
    const { host, opened } = setup(
      { runs: () => [{ ticketId: 'T-0121', worktreePath: 'E:/wt/t-0121', startedAt: 1 } as never] },
      [{ id: 'wt', path: 'E:\\wt\\t-0121' }],
    );
    await flush();
    click(byText(host, '.tickets-review-filebar .tickets-review-btn', 'Open in editor'));
    await flush();
    expect(opened).toEqual([['src/a.ts', undefined, { vaultId: 'wt' }]]);
  });

  it('falls back to a scratch copy when no vault holds the worktree', async () => {
    const { host, deps } = setup();
    await flush();
    click(byText(host, '.tickets-review-filebar .tickets-review-btn', 'Open in editor'));
    await flush();
    expect(deps.api.documents.openScratch).toHaveBeenCalledWith('src/a.ts', expect.stringContaining('TWO'));
  });
});
