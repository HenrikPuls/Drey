// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import type { NormalizedEvent } from '../main/fleet/providers';
import { createTranscriptView, shortenTarget, transcriptItems } from './transcript-view';
import { formatWatch, type WatchBlock } from './watch-format';

const api = { ui: { highlightCode: () => Promise.resolve(null) } } as unknown as DreyPluginApi;

const ev = (event: Partial<NormalizedEvent> & { kind: NormalizedEvent['kind'] }): NormalizedEvent =>
  ({ ts: '2026-10-29T10:00:00Z', ...event }) as NormalizedEvent;

const step = (n: number): WatchBlock => ({ kind: 'step', markdown: `● **Read** \`f${n}\``, step: { name: 'Read', target: `f${n}` } });

describe('shortenTarget', () => {
  const root = 'E:\\projects\\drey-tickets\\_worktrees\\T-0053';

  it('drops the worktree prefix in either slash and any case', () => {
    expect(shortenTarget('E:\\projects\\drey-tickets\\_worktrees\\T-0053\\plugins\\a.ts', root)).toBe('plugins\\a.ts');
    expect(shortenTarget('e:/projects/drey-tickets/_worktrees/T-0053/src/b.ts', root)).toBe('src/b.ts');
  });

  it('rewrites every mention inside a command and leaves other paths alone', () => {
    expect(shortenTarget(`grep foo ${root}\\a.ts ${root}`, root)).toBe('grep foo a.ts ');
    expect(shortenTarget('C:\\other\\x.ts', root)).toBe('C:\\other\\x.ts');
    expect(shortenTarget('src/a.ts', '')).toBe('src/a.ts');
  });
});

describe('transcriptItems', () => {
  it('folds runs of four or more steps into one group keyed by its first index', () => {
    const text: WatchBlock = { kind: 'text', markdown: 'hi' };
    const items = transcriptItems([text, step(1), step(2), text, step(3), step(4), step(5), step(6)]);
    expect(items.map((i) => i.key)).toEqual(['b0', 'b1', 'b2', 'b3', 'g4']);
    expect(items[4]).toMatchObject({ kind: 'group', tail: true });
  });
});

describe('createTranscriptView', () => {
  it('draws rows, folds and replies without Markdown artefacts', () => {
    const view = createTranscriptView(api, 'E:\\wt');
    view.update(
      formatWatch([
        ev({ kind: 'note', text: 'thinking › Look here first' }),
        ev({ kind: 'tool', tool: 'read', text: 'read E:\\wt\\src\\a.ts' }),
        ev({ kind: 'tool', tool: 'read', detail: 'done', text: 'result › 42 lines' }),
        ev({ kind: 'text', text: 'Done with **this**.' }),
      ]),
    );
    const root = view.element;
    expect(root.textContent).not.toContain('&nbsp;');
    expect(root.querySelector('.tickets-tx-think')?.hasAttribute('open')).toBe(false);
    expect(root.querySelector('.tickets-tx-think-preview')?.textContent).toBe('Look here first');
    expect(root.querySelector('.tickets-tx-target')?.textContent).toBe('src\\a.ts');
    expect(root.querySelector('.tickets-tx-outcome')?.textContent).toBe('42 lines');
    expect(root.querySelector('.tickets-tx-step')?.getAttribute('data-state')).toBe('done');
    expect(root.querySelector('.tickets-tx-reply strong')?.textContent).toBe('this');
  });

  it('renders a thought like a reply, so its code fences become code blocks', () => {
    const view = createTranscriptView(api, '');
    view.update(formatWatch([ev({ kind: 'note', text: 'thinking › The helper:\n\n```ts\nexport const a = 1;\n```' })]));
    const body = view.element.querySelector('.tickets-tx-think-body');
    expect(body?.querySelector('p')?.textContent).toBe('The helper:');
    expect(body?.querySelector('pre')?.textContent).toBe('export const a = 1;');
  });

  it('keeps unchanged nodes across pulls, so an opened thought stays open', () => {
    const view = createTranscriptView(api, '');
    const first = [ev({ kind: 'note', text: 'thinking › Plan' })];
    view.update(formatWatch(first));
    const think = view.element.querySelector('details.tickets-tx-think') as HTMLDetailsElement;
    think.open = true;
    view.update(formatWatch([...first, ev({ kind: 'text', text: 'Next' })]));
    expect(view.element.querySelector('details.tickets-tx-think')).toBe(think);
    expect(think.open).toBe(true);
  });

  it('shows the empty line until the stream brings something', () => {
    const view = createTranscriptView(api, '');
    view.update(formatWatch([]));
    expect(view.element.querySelector('.tickets-tx-empty')).not.toBeNull();
    view.update(formatWatch([ev({ kind: 'text', text: 'Hi' })]));
    expect(view.element.querySelector('.tickets-tx-empty')).toBeNull();
  });
});
