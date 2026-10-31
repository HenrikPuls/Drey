/**
 * req-66: the in-memory desk behind the tickets remote's e2e spec and its
 * screenshots — an English demo board (CLAUDE.md: screenshots are
 * English) shaped like `BoardSnapshot`, a waiting run, and a recorder of
 * every write the gateway hands the port.
 */
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(__filename);
const { needsOf } = require(path.resolve('dist-electron/plugins/tickets/main/remote/needs.js'));

interface Card {
  id: string;
  path: string;
  phase: string;
  meta: Record<string, unknown>;
  worker: string;
  blocked: string[];
  blocks: string[];
  issues: unknown[];
}

const card = (id: string, phase: string, title: string, extra: Record<string, unknown> = {}, blocked: string[] = []): Card => ({
  id,
  path: `tickets/${phase}/${id}.md`,
  phase,
  meta: {
    id,
    title,
    repo: 'drey',
    worker: null,
    priority: 'normal',
    rank: 5000,
    branch: `t/${id}`,
    claimedBy: null,
    claimedAt: null,
    run: null,
    references: [],
    blockedBy: blocked,
    parkedReason: null,
    parkedAt: null,
    entered: { [phase]: '2026-10-30T08:00:00Z' },
    ...extra,
  },
  worker: 'opencode',
  blocked,
  blocks: [],
  issues: [],
});

const PHASES: [string, string, string][] = [
  ['inbox', 'Inbox', 'manual'],
  ['prioritized', 'Prioritized', 'manual'],
  ['plan', 'Plan', 'agent plan-default'],
  ['plan-review', 'Plan review', 'manual'],
  ['build', 'Build', 'agent build-default'],
  ['review', 'Review', 'agent review-default'],
  ['commit', 'Commit', 'manual'],
  ['done', 'Done', 'none'],
];

export function makeDesk() {
  const tickets: Record<string, Card[]> = {
    inbox: [card('T-0055', 'inbox', 'Export the board as CSV')],
    prioritized: [],
    plan: [],
    'plan-review': [card('T-0053', 'plan-review', 'Phase chip moves the ticket', { priority: 'high' })],
    build: [
      card('T-0052', 'build', 'Fold duplicate phase folders', { priority: 'high', claimedBy: 'fleet@desk' }),
      card('T-0050', 'build', 'Blocked-by chips on cards', {}, ['T-0048']),
    ],
    review: [],
    commit: [],
    done: [card('T-0048', 'done', 'Run telemetry')],
  };
  const calls: { what: string; args: unknown[] }[] = [];
  const texts = new Map<string, string>();
  const revisions = new Map<string, number>();
  const textOf = (id: string): string =>
    texts.get(id) ??
    `---\nid: ${id}\n---\n\n## Description\n\nThe phase chip is **display only**: a tap opens the move menu, it never *moves* the ticket itself. The chip's target comes from \`chip → menu\`.\n\n| Surface | Formatting |\n|---|---|\n| Ticket view | bold, italic, code |\n| Transcript | tables and rules |\n\n## Plan\n\nReuse the board's move list.\n\n### Acceptance criteria\n\n- [x] The chip opens the move menu\n- [ ] One commit per move\n\n## Log\n\n- '2026-10-30T08:00:00Z' owner@desk — created in inbox\n`;
  // The iPad detail pane has to genuinely overflow for the scroll-keeping
  // e2e (R10): T-0053's Description carries twelve extra paragraphs. A
  // replacer function keeps the text free of $-pattern surprises, and
  // everything outside Description stays byte-identical to the default.
  const longDescription = [
    'The chip is the only entry point on the phone, so it has to open the same move list the desk board menu shows.',
    'A tap must never move the ticket by itself: choosing a target is a second, deliberate step.',
    'The list opens as a bottom sheet on the phone and as a popover on the iPad; both are built from one column list.',
    'Every entry names its column and, where the pipeline defines one, the handover that takes over after the move.',
    'The current column is marked and disabled, so a move to where the ticket already sits cannot be sent.',
    'Blocked tickets keep their blocked-by chips; the move list reads them the same way the cards do.',
    'A move is one POST with the ticket, the source phase and the target phase; the desk commits it.',
    'While the request is in flight the sheet stays open and its buttons go quiet, so a double tap cannot double-move.',
    'The toast names the ticket and its new column, matching the wording the desk board uses.',
    'If the desk refuses the move, the sheet closes and the refusal text is shown verbatim.',
    'The chip label never changes with the phase of the ticket; it is a button, not a status.',
    'Keyboard focus lands on the first entry when the list opens, and Escape closes it without moving anything.',
  ].join('\n\n');
  texts.set('T-0053', textOf('T-0053').replace('## Plan', () => `${longDescription}\n\n## Plan`));
  const revisionOf = (id: string): string => (revisions.get(id) ?? 1).toString(16).padStart(16, '0');
  const bump = (id: string): void => void revisions.set(id, (revisions.get(id) ?? 1) + 1);
  const listeners = new Set<(what: string) => void>();
  const emit = (): void => listeners.forEach((l) => l('board'));
  const board = () => ({
    vaultId: 'v',
    vaultName: 'drey-tickets',
    activeVaultName: 'drey-tickets',
    isGitRepo: true,
    defaultWorker: 'opencode',
    pipeline: [],
    pipelineError: null,
    pushRemote: null,
    repos: [{ name: 'drey', url: '', branch: 'main', policy: null, path: null, worker: null }],
    reposError: null,
    issues: [],
    checkpoints: ['plan-review', 'commit'],
    columns: PHASES.map(([id, title, handover]) => ({
      phase: { id, title, wip: id === 'build' ? 3 : null, claim: id === 'build', handover },
      tickets: tickets[id],
      unknown: false,
    })),
  });
  const runs: Record<string, unknown>[] = [
    {
      id: 'run-1',
      ticketId: 'T-0052',
      provider: 'opencode',
      model: 'zai/glm-5.3',
      state: 'running',
      turn: 'idle',
      startedAt: '2026-10-30T09:00:00Z',
      endedAt: null,
      phase: 'build',
      tokensIn: 48_213,
      tokensOut: 6_120,
      contextTokens: 41_000,
      costUsd: 0,
      activity: 'edit plugins/tickets/main/phase-dirs.ts',
      gateFailure: null,
      waiting: {
        kind: 'question',
        text: 'Two folders of one phase exist (inbox, 10-inbox). Fold them into 10-inbox?',
        since: '2026-10-30T09:40:00Z',
        requestId: 'que_1',
        questions: [
          {
            key: 'q0',
            question: 'Two folders of one phase exist (inbox, 10-inbox). Fold them into 10-inbox?',
            options: [{ label: 'Fold' }, { label: 'Keep both' }],
            multiple: false,
          },
        ],
      },
    },
    {
      id: 'run-0',
      ticketId: 'T-0048',
      provider: 'claude-code',
      state: 'done',
      startedAt: '2026-10-29T15:00:00Z',
      endedAt: '2026-10-29T15:40:00Z',
      phase: 'build',
      tokensIn: 120_000,
      tokensOut: 9_000,
      gateResult: 'green',
      gateFailure: null,
    },
  ];
  const stream = [
    { ts: '2026-10-30T09:00:01Z', kind: 'note', text: 'worktree reused: _worktrees/T-0052' },
    { ts: '2026-10-30T09:00:05Z', kind: 'tool', tool: 'read', text: 'read plugins/tickets/main/phase-dirs.ts' },
    { ts: '2026-10-30T09:00:06Z', kind: 'tool', tool: 'read', detail: 'done', text: 'result › 214 lines' },
    { ts: '2026-10-30T09:00:09Z', kind: 'tool', tool: 'grep', text: 'grep "10-inbox" plugins/tickets' },
    { ts: '2026-10-30T09:00:12Z', kind: 'text-delta', detail: 'end', text: 'Two directories resolve to the inbox phase. I will ask before folding them.' },
    // Long enough that the run view's page really scrolls — the pinned
    // header's e2e case (R8) needs an overflowing transcript.
    ...Array.from({ length: 45 }, (_, i) => ({ ts: '2026-10-30T09:01:00Z', kind: 'note', text: `read src/app/core/widget-${i}.ts` })),
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
  const stream2 = [
    { ts: '2026-10-30T10:30:01Z', kind: 'note', text: 'run R-2 started for T-0050' },
    { ts: '2026-10-30T10:30:05Z', kind: 'text-delta', detail: 'end', text: 'Reading the ticket first, then **three bold steps** to review.' },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
  const chain = { configured: true, master: 'run', columns: { build: 'playing', review: 'held' } as Record<string, string>, redStreak: {}, cooldownUntil: {} };
  const fleetEmit = (): void => listeners.forEach((l) => l('fleet'));
  const move = (id: string, to: string): void => {
    for (const list of Object.values(tickets)) {
      const i = list.findIndex((c) => c.id === id);
      if (i >= 0) {
        const [c] = list.splice(i, 1);
        tickets[to]!.push({ ...c!, phase: to, meta: { ...c!.meta, entered: { [to]: '2026-10-30T10:00:00Z' } } });
      }
    }
    emit();
  };
  const port = {
    board: async () => board(),
    fleet: async () => ({ runs, chain }),
    stream: async (runId: string) => (runId === 'run-1' ? stream : runId === 'run-2' ? stream2 : ''),
    needs: async () => needsOf(board(), runs),
    ticket: async (id: string) => {
      const c = Object.values(tickets).flat().find((t) => t.id === id);
      return c === undefined ? { ok: false, error: 'not found' } : { ok: true, card: c, text: textOf(id), revision: revisionOf(id) };
    },
    refine: async (cmd: { id: string; baseRevision: string; sections: Record<string, string>; header: Record<string, string> }, actor: string) => {
      calls.push({ what: 'refine', args: [cmd, actor] });
      if (cmd.baseRevision !== revisionOf(cmd.id)) {
        return { ok: false, conflict: true, error: 'The ticket changed since you opened it.' };
      }
      if (cmd.sections['plan'] !== undefined) {
        texts.set(cmd.id, textOf(cmd.id).replace(/## Plan\n\n[\s\S]*?\n\n###/, `## Plan\n\n${cmd.sections['plan']}\n\n###`));
      }
      bump(cmd.id);
      emit();
      return { ok: true, revision: revisionOf(cmd.id) };
    },
    saveAttachment: async (cmd: { bytes: Buffer; ext: string }, actor: string) => {
      calls.push({ what: 'attachment', args: [cmd, actor] });
      return { ok: true, file: 'tickets/attachments/img-test.png' };
    },
    create: async (cmd: { title: string }, actor: string) => {
      calls.push({ what: 'create', args: [cmd, actor] });
      tickets['inbox']!.push(card('T-0060', 'inbox', cmd.title));
      emit();
      return { ok: true, id: 'T-0060', path: 'tickets/inbox/T-0060.md' };
    },
    move: async (cmd: { id: string; from: string; to: string }, actor: string) => {
      calls.push({ what: 'move', args: [cmd, actor] });
      move(cmd.id, cmd.to);
      return { ok: true };
    },
    claim: async (cmd: unknown, actor: string) => {
      calls.push({ what: 'claim', args: [cmd, actor] });
      return { ok: true };
    },
    startRun: async (cmd: { ticketId: string }) => {
      calls.push({ what: 'run', args: [cmd] });
      runs.push({
        id: 'run-2',
        ticketId: cmd.ticketId,
        provider: 'opencode',
        model: 'zai/glm-5.3',
        state: 'running',
        turn: 'busy',
        startedAt: '2026-10-30T10:30:00Z',
        endedAt: null,
        tokensIn: 1_000,
        tokensOut: 100,
        gateFailure: null,
      });
      fleetEmit();
      return { ok: true, runId: 'run-2' };
    },
    answer: async (cmd: { runId: string; answers: unknown }) => {
      calls.push({ what: 'answer', args: [cmd] });
      const run = runs.find((r) => r['id'] === cmd.runId);
      if (run !== undefined) {
        run['waiting'] = null;
        run['turn'] = 'busy';
      }
      fleetEmit();
      return { ok: true };
    },
    send: async (cmd: { runId: string }) => {
      calls.push({ what: 'send', args: [cmd] });
      // A message to an ended run reopens it as a new run (the runner's rule).
      const ended = runs.find((r) => r['id'] === cmd.runId)?.['state'] === 'stopped';
      return ended ? { ok: true, rung: 'resume', runId: 'run-2' } : { ok: true };
    },
    stopRun: async (cmd: { runId: string }) => {
      calls.push({ what: 'stop', args: [cmd] });
      const run = runs.find((r) => r['id'] === cmd.runId);
      if (run !== undefined) {
        run['state'] = 'stopped';
        run['sessionRef'] = 'ses_run-1';
      }
      fleetEmit();
      return { ok: true };
    },
    chainMaster: async (mode: string) => {
      calls.push({ what: 'master', args: [mode] });
      chain.master = mode;
      fleetEmit();
      return { ok: true, status: chain };
    },
    chainColumn: async (phase: string, mode: string) => {
      calls.push({ what: 'column', args: [phase, mode] });
      chain.columns[phase] = mode;
      fleetEmit();
      return { ok: true, status: chain };
    },
    onChanged: (l: (what: string) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  /** Someone saved the ticket on the desk: its revision moves on. */
  const editOnDesk = (id: string): void => {
    bump(id);
    emit();
  };
  /** A worker tick the desk reports: run-1 moves on, the board does not. */
  const touchFleet = (patch: Record<string, unknown>): void => {
    const live = runs.find((r) => r['id'] === 'run-1');
    if (live !== undefined) {
      Object.assign(live, patch);
    }
    fleetEmit();
  };
  return { port, calls, editOnDesk, touchFleet };
}

