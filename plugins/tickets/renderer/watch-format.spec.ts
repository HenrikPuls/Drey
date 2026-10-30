import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '../main/fleet/providers';
import { formatWatch, parseStreamEvents, renderWatchMarkdown } from './watch-format';

const ev = (event: Partial<NormalizedEvent> & { kind: NormalizedEvent['kind'] }): NormalizedEvent => ({
  ts: '2026-10-19T22:00:00Z',
  ...event,
} as NormalizedEvent);

describe('parseStreamEvents', () => {
  it('parses NDJSON lines and skips junk', () => {
    const events = parseStreamEvents(
      ['{"kind":"text","text":"a"}', 'not json', '', '{"kind":"note","text":"b"}'].join('\n'),
    );
    expect(events.map((e) => e.kind)).toEqual(['text', 'note']);
  });
});

describe('formatWatch', () => {
  it('assembles live text deltas into one block the seal replaces whole', () => {
    const view = formatWatch([
      ev({ kind: 'text-delta', text: 'Found ' }),
      ev({ kind: 'text-delta', text: 'it.' }),
      ev({ kind: 'text-delta', text: 'Found it. All good.', detail: 'end' }),
    ]);
    expect(view.blocks).toEqual([{ kind: 'text', markdown: 'Found it. All good.' }]);
  });

  it('an unsealed delta run stays live and a different event seals it', () => {
    const view = formatWatch([
      ev({ kind: 'text-delta', text: 'Half a' }),
      ev({ kind: 'text-delta', text: ' reply' }),
      ev({ kind: 'note', text: 'read src/a.ts' }),
      ev({ kind: 'text-delta', text: 'next part' }),
    ]);
    expect(view.blocks.map((b) => [b.kind, b.live])).toEqual([
      ['text', false],
      ['step', undefined],
      ['text', true],
    ]);
    expect(view.blocks[0]?.markdown).toBe('Half a reply');
  });

  it('a seal replaces the fragments its tool calls cut up, at the first fragment', () => {
    const view = formatWatch([
      ev({ kind: 'text-delta', text: 'The model is' }),
      ev({ kind: 'tool', tool: 'read', text: 'read a.ts' }),
      ev({ kind: 'text-delta', text: ' clear now.' }),
      ev({ kind: 'tool', tool: 'grep', text: 'grep x' }),
      ev({ kind: 'text-delta', text: 'The model is clear now.', detail: 'end' }),
    ]);
    expect(view.blocks.map((b) => [b.kind, b.markdown])).toEqual([
      ['text', 'The model is clear now.'],
      ['step', '● **Read** `a.ts`'],
      ['step', '● **Grep** `x`'],
    ]);
  });

  it('renders tool events as steps: running, enriched call, settled outcome', () => {
    const view = formatWatch([
      ev({ kind: 'tool', tool: 'read', detail: 'running' }),
      ev({ kind: 'tool', tool: 'read', text: 'read src/a.ts' }),
      ev({ kind: 'tool', tool: 'read', detail: 'done', text: 'result › 42 lines' }),
      ev({ kind: 'tool', tool: 'shell', detail: 'running' }),
      ev({ kind: 'tool', tool: 'shell', text: 'shell git status' }),
      ev({ kind: 'tool', tool: 'shell', detail: 'failed', text: 'result › exit 1' }),
      ev({ kind: 'tool', tool: 'grep', detail: 'done', text: 'result › no such call above' }),
    ]);
    const steps = view.blocks.filter((b) => b.kind === 'step');
    expect(steps.map((b) => b.markdown)).toEqual([
      '● **Read** `src/a.ts`  \n⎿ _42 lines_',
      '● **Shell** `git status`  \n⎿ _failed: exit 1_',
    ]);
    expect(steps.map((b) => b.step)).toEqual([
      { name: 'Read', target: 'src/a.ts', outcome: '42 lines' },
      { name: 'Shell', target: 'git status', outcome: 'exit 1', failed: true },
    ]);
  });

  it('pairs parallel calls in call order and drops input-less placeholders when the turn ends', () => {
    const view = formatWatch([
      ev({ kind: 'tool', tool: 'read', detail: 'running' }),
      ev({ kind: 'tool', tool: 'read', detail: 'running' }),
      ev({ kind: 'tool', tool: 'read', text: 'read a.ts' }),
      ev({ kind: 'tool', tool: 'read', text: 'read b.ts' }),
      ev({ kind: 'tool', tool: 'read', detail: 'done', text: 'result › 1 line' }),
      ev({ kind: 'tool', tool: 'read', detail: 'done', text: 'result › 2 lines' }),
      ev({ kind: 'tool', tool: 'grep', detail: 'running' }),
      ev({ kind: 'note', text: 'run finished (exit 0)' }),
      ev({ kind: 'result', text: '' }),
    ]);
    expect(view.blocks.filter((b) => b.kind === 'step').map((b) => [b.step, b.live])).toEqual([
      [{ name: 'Read', target: 'a.ts', outcome: '1 line' }, false],
      [{ name: 'Read', target: 'b.ts', outcome: '2 lines' }, false],
    ]);
    expect(view.blocks.map((b) => b.kind)).toEqual(['step', 'step', 'setup', 'result']);
  });

  it('hangs an outcome that names its target under that call, whatever the order', () => {
    const view = formatWatch([
      ev({ kind: 'tool', tool: 'read', text: 'read src/main' }),
      ev({ kind: 'tool', tool: 'read', text: 'read src/renderer' }),
      ev({ kind: 'tool', tool: 'read', detail: 'done', text: 'result › Read directory src/renderer, 3 entries' }),
      ev({ kind: 'tool', tool: 'read', detail: 'done', text: 'result › Read directory src/main, 5 entries' }),
    ]);
    expect(view.blocks.map((b) => [b.step?.target, b.step?.outcome])).toEqual([
      ['src/main', 'Read directory src/main, 5 entries'],
      ['src/renderer', 'Read directory src/renderer, 3 entries'],
    ]);
  });

  it('carries a running call and a thought as data for the DOM view', () => {
    const view = formatWatch([
      ev({ kind: 'note', text: 'thinking › First line\nsecond line' }),
      ev({ kind: 'tool', tool: 'grep', detail: 'running' }),
    ]);
    expect(view.blocks[0]?.thought).toBe('First line\nsecond line');
    expect(view.blocks[1]).toMatchObject({ kind: 'step', live: true, step: { name: 'Grep', target: '' } });
  });

  it('keeps the note language: thinking callouts, owner quotes, setup, results, errors', () => {
    const view = formatWatch([
      ev({ kind: 'note', text: 'thinking › Look\nhere' }),
      ev({ kind: 'note', text: 'you › do it' }),
      ev({ kind: 'note', text: 'run R-1 for T-1 on t/T-1' }),
      ev({ kind: 'note', text: 'read src/a.ts' }),
      ev({ kind: 'note', text: 'result › 3 files' }),
      ev({ kind: 'error', text: 'boom' }),
    ]);
    expect(view.blocks.map((b) => b.kind)).toEqual(['thinking', 'you', 'setup', 'step', 'error']);
    expect(view.blocks[0]?.markdown).toContain('[!QUOTE]- Thinking — Look here');
    expect(view.blocks[3]?.markdown).toBe('● **Read** `src/a.ts`  \n⎿ _3 files_');
  });

  it('drops a result body the last sealed reply already said', () => {
    const sealed = formatWatch([
      ev({ kind: 'text-delta', text: 'All done.', detail: 'end' }),
      ev({ kind: 'result', text: 'All done.' }),
    ]);
    expect(sealed.blocks.at(-1)?.markdown).toBe('---\n\n**✓ Turn finished**');
    const repeated = formatWatch([
      ev({ kind: 'text', text: 'All done.' }),
      ev({ kind: 'result', text: 'Something else' }),
    ]);
    expect(repeated.blocks.at(-1)?.markdown).toBe('---\n\n**✓ Turn finished**\n\nSomething else');
  });

  it('carries the last usage that reported tokens and the stream\'s span', () => {
    const view = formatWatch([
      ev({ kind: 'usage', commands: ['compact'] }),
      ev({ ts: '2026-10-19T22:00:00Z', kind: 'usage', tokensIn: 10, tokensOut: 2 }),
      ev({ ts: '2026-10-19T22:01:30Z', kind: 'usage', tokensIn: 20, tokensOut: 4, costUsd: 0.5 }),
    ]);
    expect(view.lastUsage).toEqual({ tokensIn: 20, tokensOut: 4, costUsd: 0.5 });
    expect(view.elapsedMs).toBe(90_000);
  });

  it('is empty for an empty stream', () => {
    expect(formatWatch([]).blocks).toEqual([]);
    expect(formatWatch([]).elapsedMs).toBe(0);
    expect(formatWatch([]).lastUsage).toBeUndefined();
  });
});

describe('renderWatchMarkdown', () => {
  it('keeps a run of steps on shared lines and separates the rest', () => {
    const md = renderWatchMarkdown(
      formatWatch([
        ev({ kind: 'tool', tool: 'read', text: 'read src/a.ts' }),
        ev({ kind: 'tool', tool: 'shell', text: 'shell git status' }),
        ev({ kind: 'text', text: 'Now I know the layout.' }),
      ]),
    );
    expect(md).toBe('● **Read** `src/a.ts`  \n● **Shell** `git status`\n\nNow I know the layout.');
  });
});
