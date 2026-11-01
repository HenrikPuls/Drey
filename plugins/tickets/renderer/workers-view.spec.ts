// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { mountWorkers, NUDGE_TEXT, workerCards, workersNode, type WorkersViewDeps } from './workers-view';
import type { RunInfo } from '../main/fleet/protocol';
import type { NormalizedEvent } from '../main/fleet/providers';

// --- the Work panel's Workers section (milestone 95) --------------------------

const NOW = Date.parse('2026-10-31T12:00:00Z');

const sectionRun = (over: Partial<RunInfo>): RunInfo =>
  ({
    id: 'R-1',
    ticketId: 'T-0001',
    provider: 'claude-code',
    state: 'running',
    startedAt: '2026-10-31T11:30:00Z',
    lastActivity: '2026-10-31T11:59:50Z',
    tokensIn: 1_200_000,
    tokensOut: 4_000,
    turn: 'busy',
    activity: 'bash npm test',
    ...over,
  }) as RunInfo;

describe('workerCards', () => {
  it('puts the runs that need a look first and names the state in words', () => {
    const cards = workerCards(
      [
        sectionRun({ id: 'R-ok', ticketId: 'T-0002' }),
        sectionRun({ id: 'R-stuck', ticketId: 'T-0003', stuck: true, lastActivity: '2026-10-31T11:40:00Z' }),
        sectionRun({ id: 'R-paused', ticketId: 'T-0001', paused: true, held: true, turn: 'idle' }),
      ],
      NOW,
    );
    expect(cards.map((c) => c.runId)).toEqual(['R-stuck', 'R-paused', 'R-ok']);
    expect(cards.map((c) => c.state)).toEqual(['Looks stuck', 'Paused', expect.any(String)]);
  });

  it('shows what the worker does now and offers Continue only on a paused run', () => {
    const [busy] = workerCards([sectionRun({})], NOW);
    expect(busy!.now).toBe('bash npm test');
    expect(busy!.actions).toEqual(['pause', 'stop', 'tell']);
    const [paused] = workerCards([sectionRun({ paused: true, held: true, turn: 'idle' })], NOW);
    expect(paused!.actions).toEqual(['continue', 'stop', 'tell']);
    expect(paused!.now).toContain('Continue picks the step up');
  });

  it('a waiting worker shows its question as the Now line', () => {
    const [card] = workerCards(
      [sectionRun({ waiting: { kind: 'question', text: 'Move the section?\nTicket: x', since: '2026-10-31T11:59:00Z' }, turn: 'idle' })],
      NOW,
    );
    expect(card!.now).toBe('Move the section?');
    expect(card!.state).toBe('Waits for your answer');
  });
});

describe('workersNode — Tell and Nudge', () => {
  const api = { ui: { icon: () => document.createElement('span') } } as unknown as DreyPluginApi;

  it('Tell… opens an input; Send hands the text to the card action and closes it', () => {
    const deps = { api, open: vi.fn(), act: vi.fn() };
    const node = workersNode(deps, [sectionRun({})], NOW)!;
    const form = node.querySelector<HTMLFormElement>('.tickets-worker-tell')!;
    expect(form.hidden).toBe(true);
    const buttons = [...node.querySelectorAll<HTMLButtonElement>('.icon-btn')];
    buttons[buttons.length - 1]!.click(); // Tell… is the last icon
    expect(form.hidden).toBe(false);
    const input = form.querySelector('input')!;
    input.value = 'use the second option';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(deps.act).toHaveBeenCalledWith('R-1', 'tell', 'use the second option');
    expect(form.hidden).toBe(true);
  });

  it('a stuck worker offers Nudge', () => {
    const deps = { api, open: vi.fn(), act: vi.fn() };
    const node = workersNode(deps, [sectionRun({ stuck: true, lastActivity: '2026-10-31T11:40:00Z' })], NOW)!;
    node.querySelector<HTMLButtonElement>('.tickets-worker-nudge')!.click();
    expect(deps.act).toHaveBeenCalledWith('R-1', 'nudge');
    expect(workersNode(deps, [sectionRun({})], NOW)!.querySelector('.tickets-worker-nudge')).toBeNull();
  });
});

describe('workersNode', () => {
  const api = { ui: { icon: () => document.createElement('span') } } as unknown as DreyPluginApi;

  it('is null without workers; cards carry working actions', () => {
    const deps = { api, open: vi.fn(), act: vi.fn() };
    expect(workersNode(deps, [], NOW)).toBeNull();
    const node = workersNode(deps, [sectionRun({})], NOW)!;
    expect(node.querySelector('.tickets-workers-head')?.textContent).toBe('Workers · 1');
    node.querySelector<HTMLButtonElement>('.icon-btn')!.click();
    expect(deps.act).toHaveBeenCalledWith('R-1', 'pause');
    node.querySelector<HTMLButtonElement>('.tickets-worker-ticket')!.click();
    expect(deps.open).toHaveBeenCalledWith('T-0001');
  });
});

// --- the Workers tab (req-75 W4b) ---------------------------------------------

describe('mountWorkers (req-75 W4b)', () => {
  const iso = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * 60_000).toISOString();

  const run = (over: Partial<RunInfo> = {}): RunInfo => ({
    id: 'R-1',
    ticketId: 'T-0001',
    provider: 'opencode',
    state: 'running',
    pid: 1,
    startedAt: iso(30),
    endedAt: null,
    sessionRef: null,
    tokensIn: 900_000,
    tokensOut: 100_000,
    costUsd: null,
    lastActivity: iso(0),
    steerCount: 0,
    lastSteerRung: null,
    worktreePath: 'wt',
    branch: 't/T-0001',
    gateFailure: null,
    ...over,
  });

  /** The run's stream as NDJSON, one event per line. */
  const streamOf = (events: readonly NormalizedEvent[]): string => events.map((event) => JSON.stringify(event)).join('\n');

  const call = (tool: string, target: string, minutesAgo: number): NormalizedEvent => ({
    ts: iso(minutesAgo),
    kind: 'note',
    text: `${tool} ${target}`,
    tool,
  });

  const deps = (over: Partial<WorkersViewDeps> = {}): WorkersViewDeps => ({
    runs: vi.fn(() => []),
    stream: vi.fn(async () => ''),
    pools: () => [
      { id: 'opencode', label: 'OpenCode', size: 2 },
      { id: 'claude-code', label: 'Claude Code', size: 3 },
    ],
    queue: () => null,
    titleOf: (id: string) => `Title of ${id}`,
    providerLabel: (provider: string) => (provider === 'opencode' ? 'OpenCode' : 'Claude Code'),
    todayTokens: () => 1_900_000,
    control: vi.fn(),
    stop: vi.fn(async () => true),
    send: vi.fn(),
    startRun: vi.fn(),
    pauseAll: vi.fn(),
    stopAll: vi.fn(),
    openTicket: vi.fn(),
    onRunsChanged: () => () => undefined,
    ...over,
  });

  const click = (node: Element): void => {
    (node as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  };

  const byLabel = (root: Element, label: string): HTMLButtonElement | null =>
    [...root.querySelectorAll('button')].find((b) => b.textContent === label) ?? null;

  const mount = (d: WorkersViewDeps): { host: HTMLElement; dispose: () => void } => {
    const host = document.createElement('div');
    document.body.append(host);
    const dispose = mountWorkers(d, host);
    return { host, dispose };
  };

  it('shows one card per live run, the pool chips, the queue line and the footer', async () => {
    const working = run({ id: 'R-1', ticketId: 'T-0100', startedAt: iso(6), turn: 'busy', activity: 'edit electron/capture-hotkey.ts', model: 'qwen3-coder' });
    const waiting = run({
      id: 'R-2',
      ticketId: 'T-0200',
      startedAt: iso(6),
      provider: 'claude-code',
      model: 'sonnet',
      contextTokens: 88_000,
      contextWindow: 200_000,
      waiting: { kind: 'question', text: 'Which colour?', since: iso(3) },
    });
    const d = deps({
      runs: () => [working, waiting],
      stream: vi.fn(async () => streamOf([call('read', 'src/a.ts', 2)])),
      queue: () => ({ count: 1, blocked: { title: 'Win+H hand-off', blocker: 'T-0130' } }),
    });
    const { host, dispose } = mount(d);
    await vi.waitFor(() => expect(host.querySelectorAll('.tickets-workers-card')).toHaveLength(2));
    expect(host.querySelector('.tickets-workers-h1')!.textContent).toBe('Workers');
    expect(host.querySelector('.tickets-workers-pool')!.textContent).toBe('OpenCode');
    expect(host.querySelector('.tickets-workers-pool-size')!.textContent).toBe('1/2');
    expect([...host.querySelectorAll('.tickets-workers-pool')].map((n) => n.textContent)).toEqual(['OpenCode', 'Claude Code']);
    expect(host.querySelector('.tickets-workers-queue')!.textContent).toBe('1 queued · Win+H hand-off waits for T-0130');
    const cards = [...host.querySelectorAll('.tickets-workers-card')];
    expect(cards[0]!.classList.contains('is-working')).toBe(true);
    expect(cards[0]!.querySelector('.tickets-workers-title')!.textContent).toBe('Title of T-0100');
    expect(cards[0]!.querySelector('.tickets-workers-meta')!.textContent).toContain('OpenCode · qwen3-coder');
    expect(cards[1]!.querySelector('.tickets-workers-meta')!.textContent).toContain('context 44%');
    expect(cards[1]!.classList.contains('is-waiting')).toBe(true);
    expect(cards[0]!.querySelector('.tickets-workers-activity')!.textContent).toBe('edit electron/capture-hotkey.ts');
    expect(host.querySelector('.tickets-workers-foot')!.textContent).toBe('2 workers · today 1.9M tokens');
    dispose();
    expect(host.children).toHaveLength(0);
  });

  it('flags a stuck run: the word, the hint, and Nudge / Hand to the other worker / Stop', async () => {
    const stuck = run({ id: 'R-9', ticketId: 'T-0300', turn: 'busy', activity: 'read src/app/settings/settings-shell.ts', contextTokens: 156_000, contextWindow: 200_000 });
    const events = [
      call('edit', 'src/a.ts', 20),
      call('read', 'src/settings.ts', 4),
      call('read', 'src/settings.ts', 3),
      call('read', 'src/settings.ts', 2),
      call('read', 'src/settings.ts', 1),
    ];
    const d = deps({ runs: () => [stuck], stream: vi.fn(async () => streamOf(events)) });
    const { host, dispose } = mount(d);
    await vi.waitFor(() =>
      expect(host.querySelector('.tickets-workers-hint')!.textContent).toBe('Read the same files 4 times without an edit.'),
    );
    const card = host.querySelector('.tickets-workers-card')!;
    expect(card.querySelector('.tickets-workers-state')!.textContent).toBe('Looks stuck');
    expect(card.querySelector('.tickets-workers-hint')!.textContent).toBe('Read the same files 4 times without an edit.');
    expect(byLabel(card, 'Nudge')).not.toBeNull();
    expect(byLabel(card, 'Hand to Claude Code')).not.toBeNull();
    expect(byLabel(card, 'Take over')).toBeNull();
    click(byLabel(card, 'Nudge')!);
    expect(d.send).toHaveBeenCalledWith('R-9', NUDGE_TEXT);
    expect(NUDGE_TEXT).toBe(
      'You have been quiet for a while. Say in one line what you are doing now. If you are blocked on a decision, ask with QUESTION:; otherwise carry on with the step.',
    );
    click(byLabel(card, 'Hand to Claude Code')!);
    await vi.waitFor(() => expect(d.startRun).toHaveBeenCalledWith('T-0300', 'claude-code'));
    expect(d.stop).toHaveBeenCalledWith('R-9', 'handed to Claude Code by the owner');
    dispose();
  });

  it('honours the fleet’s own stuck flag even when the stream shows progress', async () => {
    const flagged = run({ id: 'R-7', ticketId: 'T-0302', turn: 'busy', stuck: true, activity: 'read src/a.ts' });
    const d = deps({ runs: () => [flagged], stream: vi.fn(async () => streamOf([call('edit', 'src/a.ts', 1)])) });
    const { host, dispose } = mount(d);
    await vi.waitFor(() => expect(host.querySelector('.tickets-workers-card')!.classList.contains('is-stuck')).toBe(true));
    const card = host.querySelector('.tickets-workers-card')!;
    expect(card.querySelector('.tickets-workers-state')!.textContent).toBe('Looks stuck');
    expect(byLabel(card, 'Nudge')).not.toBeNull();
    dispose();
  });

  it('says the context is filling up when the fill is high, and plain minutes below 60%', async () => {
    const filling = run({ id: 'R-9', ticketId: 'T-0300', turn: 'busy', contextTokens: 156_000, contextWindow: 200_000 });
    const light = run({ id: 'R-8', ticketId: 'T-0301', turn: 'busy', contextTokens: 60_000, contextWindow: 200_000 });
    const events = [call('edit', 'src/a.ts', 12)];
    const d = deps({ runs: () => [filling, light], stream: vi.fn(async () => streamOf(events)) });
    const { host, dispose } = mount(d);
    await vi.waitFor(() =>
      expect([...host.querySelectorAll('.tickets-workers-hint')].map((n) => n.textContent)).toContain(
        'No progress for 12 minutes and the context is filling up.',
      ),
    );
    const hints = [...host.querySelectorAll('.tickets-workers-hint')].map((n) => n.textContent);
    expect(hints).toContain('No progress for 12 minutes and the context is filling up.');
    expect(hints).toContain('No progress for 12 minutes.');
    dispose();
  });

  it('a waiting run answers on its ticket page, never flags stuck, and keeps Take over', async () => {
    const waiting = run({
      id: 'R-2',
      ticketId: 'T-0200',
      turn: 'busy',
      waiting: { kind: 'question', text: 'Which colour?', since: iso(20) },
    });
    const d = deps({
      runs: () => [waiting],
      stream: vi.fn(async () => streamOf([call('edit', 'src/a.ts', 20)])),
    });
    const { host, dispose } = mount(d);
    await vi.waitFor(() => expect(host.querySelector('.tickets-workers-card')!.classList.contains('is-waiting')).toBe(true));
    const card = host.querySelector('.tickets-workers-card')!;
    expect(card.querySelector('.tickets-workers-hint')).toBeNull();
    expect(card.querySelector('.tickets-workers-state')!.textContent).toBe('Waiting for you');
    const answer = byLabel(card, 'Answer')!;
    expect(answer.classList.contains('tickets-takeover-btn-primary')).toBe(true);
    click(answer);
    expect(d.openTicket).toHaveBeenCalledWith('T-0200');
    click(byLabel(card, 'Take over')!);
    expect(d.control).toHaveBeenCalledWith('takeover', 'R-2');
    click(byLabel(card, 'Stop')!);
    expect(d.stop).toHaveBeenCalledWith('R-2', null);
    dispose();
  });

  it('a working run pauses (a pause Continue resumes), takes over, and tells through a one-line input', async () => {
    const working = run({ id: 'R-1', ticketId: 'T-0100', startedAt: iso(6), turn: 'busy', activity: 'npm run typecheck' });
    const d = deps({ runs: () => [working], stream: vi.fn(async () => '') });
    const { host, dispose } = mount(d);
    await vi.waitFor(() => expect(host.querySelector('.tickets-workers-card')!.classList.contains('is-working')).toBe(true));
    const card = host.querySelector('.tickets-workers-card')!;
    click(byLabel(card, 'Pause')!);
    expect(d.control).toHaveBeenCalledWith('pause', 'R-1');
    // Tell… opens the labelled input with a Send button inside the card.
    click(byLabel(card, 'Tell…')!);
    const redrawn = host.querySelector('.tickets-workers-card')!;
    const input = redrawn.querySelector('.tickets-workers-tellinput') as HTMLInputElement;
    expect(input.getAttribute('aria-label')).toBe('Tell the worker');
    input.value = 'use the shared parser';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    click(byLabel(redrawn, 'Send')!);
    expect(d.send).toHaveBeenCalledWith('R-1', 'use the shared parser');
    await vi.waitFor(() => expect(host.querySelector('.tickets-workers-tellinput')).toBeNull());
    dispose();
  });

  it('a paused run offers Continue (primary), never Pause, and never flags stuck', async () => {
    const paused = run({ id: 'R-3', ticketId: 'T-0400', turn: 'idle', paused: true, held: true, activity: '' });
    const d = deps({
      runs: () => [paused],
      stream: vi.fn(async () => streamOf([call('edit', 'src/a.ts', 20)])),
    });
    const { host, dispose } = mount(d);
    await vi.waitFor(() => expect(host.querySelector('.tickets-workers-card')!.classList.contains('is-paused')).toBe(true));
    const card = host.querySelector('.tickets-workers-card')!;
    expect(card.querySelector('.tickets-workers-state')!.textContent).toBe('Paused');
    expect(card.querySelector('.tickets-workers-hint')).toBeNull();
    expect(byLabel(card, 'Pause')).toBeNull();
    const cont = byLabel(card, 'Continue')!;
    expect(cont.classList.contains('tickets-takeover-btn-primary')).toBe(true);
    click(cont);
    expect(d.control).toHaveBeenCalledWith('continue', 'R-3');
    dispose();
  });

  it('Stop all needs two clicks and relabels in between', () => {
    const d = deps({ runs: () => [run({ turn: 'busy' })] });
    const { host, dispose } = mount(d);
    const stopAll = byLabel(host, 'Stop all')!;
    click(stopAll);
    expect(d.stopAll).not.toHaveBeenCalled();
    expect(byLabel(host, 'Stop all — click again')).not.toBeNull();
    click(byLabel(host, 'Stop all — click again')!);
    expect(d.stopAll).toHaveBeenCalledTimes(1);
    expect(byLabel(host, 'Stop all')).not.toBeNull();
    dispose();
  });

  it('Pause all interrupts through the host; the empty board says so and disables the buttons', () => {
    const d = deps();
    const { host, dispose } = mount(d);
    expect(host.querySelector('.tickets-workers-empty')!.textContent).toBe('No worker is running.');
    expect(host.querySelector('.tickets-workers-foot')!.textContent).toBe('0 workers · today 1.9M tokens');
    expect(byLabel(host, 'Pause all after this step')!.disabled).toBe(true);
    expect(byLabel(host, 'Stop all')!.disabled).toBe(true);
    dispose();
    const live = deps({ runs: () => [run({ turn: 'busy' })] });
    const second = mount(live);
    click(byLabel(second.host, 'Pause all after this step')!);
    expect(live.pauseAll).toHaveBeenCalledTimes(1);
    second.dispose();
  });
});
