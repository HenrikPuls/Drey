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
  pinned: boolean;
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
  pinned: false,
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
  const runs = [
    {
      id: 'run-1',
      ticketId: 'T-0052',
      provider: 'opencode',
      state: 'running',
      startedAt: '2026-10-30T09:00:00Z',
      phase: 'build',
      gateFailure: null,
      waiting: { kind: 'question', text: 'Two folders of one phase exist (inbox, 10-inbox). Fold them into 10-inbox?', since: '2026-10-30T09:40:00Z' },
    },
  ];
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
    fleet: async () => ({ runs, chain: { configured: true, master: 'run', columns: { build: 'playing', review: 'held' }, redStreak: {}, cooldownUntil: {} } }),
    needs: async () => needsOf(board(), runs),
    ticket: async (id: string) => {
      const c = Object.values(tickets).flat().find((t) => t.id === id);
      return c === undefined
        ? { ok: false, error: 'not found' }
        : {
            ok: true,
            card: c,
            text: `---\nid: ${id}\n---\n\n## Description\n\nThe phase chip is display only.\n\n## Plan\n\nReuse the board's move list.\n\n### Acceptance criteria\n\n- [x] The chip opens the move menu\n- [ ] One commit per move\n\n## Log\n\n- '2026-10-30T08:00:00Z' owner@desk — created in inbox\n`,
          };
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
    startRun: async (cmd: unknown) => {
      calls.push({ what: 'run', args: [cmd] });
      return { ok: true, runId: 'run-2' };
    },
    onChanged: (l: (what: string) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return { port, calls };
}

