import { promises as fsp, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatBridge, ChatCommand, ChatProposal, ChatStreamEvent } from '../contracts/chat';
import type { BoardSnapshot } from '../contracts/tickets';
import {
  appendMission,
  appendOwner,
  appendProposal,
  decideProposal,
  newSessionText,
  parseSessionFile,
  sessionSlug,
} from '../core/chat-session';
import type { TicketsGit } from '../core/tickets-git';
import { ChatService, type ChatBoardPort } from './chat-service';
import type { EngineHost } from './host';

/**
 * The Mission Control chat service (E5a): the session files are the
 * truth — every round lands as one write and one commit, proposal cards
 * stay pending until the owner's decision, confirm executes through the
 * board port with the actor, dismiss never executes. Fakes for the
 * board/bridge/git over a real temp vault, so the mtimes the listing
 * sorts by are the filesystem's own.
 */

const ACTOR = 'owner@desk';
/** The digest's documented ceiling (services/chat-service.ts). */
const DIGEST_CAP = 2_000;

const TRANSITION: ChatCommand = { kind: 'transition', id: 'T-0086', from: 'build', to: 'review' };
const CREATE_IN_INBOX: ChatCommand = {
  kind: 'createTicket',
  title: 'Fix the CSV export',
  description: 'The export drops a column.',
  priority: 'high',
  phase: 'inbox',
};
const CREATE_IN_BUILD: ChatCommand = { ...CREATE_IN_INBOX, phase: 'build' };
const SET_PRIORITY: ChatCommand = { kind: 'setPriority', id: 'T-0086', priority: 'urgent' };
const PROMOTE: ChatCommand = { kind: 'promote', id: 'T-0086' };
const SET_CHAIN: ChatCommand = {
  kind: 'setChain',
  id: 'T-0086',
  chain: ['insert design(pia, notify) after review', 'skip verify'],
};
const RETURN_TO_STANDARD: ChatCommand = { kind: 'setChain', id: 'T-0086', chain: [] };

interface FakeCard {
  id: string;
  path: string;
  phase: string;
  meta: { title: string | null };
}

interface FakeSnapshot {
  vaultId: string | null;
  pipeline: { id: string }[];
  columns: { phase: { id: string }; tickets: FakeCard[]; unknown: boolean }[];
}

interface BridgeInput {
  text: string;
  history: readonly { role: 'owner' | 'mission'; text: string }[];
  board: string;
}

type BridgeReply = { readonly say: string; readonly thought: string | null; readonly commands: readonly ChatCommand[] };

let root: string;
let vaultPath: string;
let commits: { root: string; paths: string[]; message: string }[];
let announced: string[];
let events: { file: string; event: ChatStreamEvent }[];
let bridgeInputs: BridgeInput[];
let bridgeRuns: number;
let scriptedEvents: ChatStreamEvent[];
let bridgeReply: BridgeReply | null;
let bridgeGate: ((input: BridgeInput & { emit: (event: ChatStreamEvent) => void }) => Promise<BridgeReply>) | null;
let boardSnapshot: FakeSnapshot;
let boardCreates: unknown[];
let boardTransitions: unknown[];
let boardPriorities: unknown[];
let boardForms: unknown[];
let boardChains: unknown[];
let boardCreateResult: unknown;
let boardTransitionResult: unknown;
let boardSetPriorityResult: unknown;
let boardSetFormResult: unknown;
let boardSetChainResult: unknown;
let clock: Date;
let service: ChatService;

async function walkMarkdown(absDir: string, prefix: string, out: string[]): Promise<void> {
  const entries = await fsp.readdir(absDir, { withFileTypes: true }).catch(() => [] as Dirent[]);
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === '.git') {
        continue;
      }
      await walkMarkdown(path.join(absDir, entry.name), rel, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(rel);
    }
  }
}

function makeSnapshot(patch: Partial<FakeSnapshot> = {}): FakeSnapshot {
  return {
    vaultId: 'vault',
    pipeline: [{ id: 'inbox' }, { id: 'build' }, { id: 'review' }, { id: 'done' }],
    columns: [
      { phase: { id: 'inbox' }, tickets: [], unknown: false },
      {
        phase: { id: 'build' },
        tickets: [{ id: 'T-0086', path: 'tickets/20-build/T-0086.md', phase: 'build', meta: { title: 'Fix the CSV export' } }],
        unknown: false,
      },
      { phase: { id: 'review' }, tickets: [], unknown: false },
      {
        phase: { id: 'done' },
        tickets: [{ id: 'T-0071', path: 'tickets/40-done/T-0071.md', phase: 'done', meta: { title: 'Shipped already' } }],
        unknown: false,
      },
    ],
    ...patch,
  };
}

function tick(): Date {
  const at = clock;
  clock = new Date(clock.getTime() + 1_000);
  return at;
}

async function waitFor(cond: () => boolean, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(cond()).toBe(true);
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(tmpdir(), 'chat-service-'));
  vaultPath = path.join(root, 'vault');
  await fsp.mkdir(vaultPath, { recursive: true });
  commits = [];
  announced = [];
  events = [];
  bridgeInputs = [];
  bridgeRuns = 0;
  scriptedEvents = [];
  bridgeReply = null;
  bridgeGate = null;
  boardSnapshot = makeSnapshot();
  boardCreates = [];
  boardTransitions = [];
  boardPriorities = [];
  boardForms = [];
  boardChains = [];
  boardCreateResult = { ok: true, id: 'T-0103', path: 'tickets/10-inbox/T-0103.md' };
  boardTransitionResult = { ok: true, path: 'tickets/30-review/T-0086.md' };
  boardSetPriorityResult = { ok: true };
  boardSetFormResult = { ok: true };
  boardSetChainResult = { ok: true };
  clock = new Date('2026-11-02T09:00:00Z');
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

function boot(): ChatService {
  const host = {
    listVaults: async () => [{ id: 'vault', name: 'vault', path: vaultPath, exists: true, active: true }],
    read: async (_vault: string, p: string) => fsp.readFile(path.join(vaultPath, p), 'utf8'),
    write: async (_vault: string, p: string, text: string) => {
      await fsp.mkdir(path.dirname(path.join(vaultPath, p)), { recursive: true });
      await fsp.writeFile(path.join(vaultPath, p), text, 'utf8');
    },
    listMarkdownFiles: async () => {
      const out: string[] = [];
      await walkMarkdown(vaultPath, '', out);
      return out;
    },
    resolveAssetPath: (_vault: string, p: string) => path.join(vaultPath, p),
    announceChanges: (_vault: string, paths: readonly string[]) => {
      announced.push(...paths);
    },
  } as unknown as EngineHost;
  const board = {
    snapshot: async () => boardSnapshot as unknown as BoardSnapshot,
    createTicket: async (input: unknown) => {
      boardCreates.push(input);
      return boardCreateResult;
    },
    transition: async (input: unknown) => {
      boardTransitions.push(input);
      return boardTransitionResult;
    },
    setPriority: async (input: unknown) => {
      boardPriorities.push(input);
      return boardSetPriorityResult;
    },
    setForm: async (input: unknown) => {
      boardForms.push(input);
      return boardSetFormResult;
    },
    setChain: async (input: unknown) => {
      boardChains.push(input);
      return boardSetChainResult;
    },
  } as unknown as ChatBoardPort;
  const bridge = {
    runTurn: async (input: BridgeInput & { emit: (event: ChatStreamEvent) => void }) => {
      bridgeRuns += 1;
      bridgeInputs.push({ text: input.text, history: input.history, board: input.board });
      for (const event of scriptedEvents) {
        input.emit(event);
      }
      return bridgeGate === null ? (bridgeReply ?? { say: 'Understood.', thought: null, commands: [] }) : bridgeGate(input);
    },
  } as unknown as ChatBridge;
  const git = {
    locate: async (p: string) => ({ root: p, prefix: '' }),
    commitPaths: async (rootDir: string, paths: readonly string[], message: string) => {
      commits.push({ root: rootDir, paths: [...paths], message });
    },
  } as unknown as TicketsGit;
  return new ChatService({
    host,
    board,
    bridge,
    actor: ACTOR,
    log: () => undefined,
    onEvent: (file, event) => {
      events.push({ file, event });
    },
    now: tick,
    git,
  });
}

/** Writes a session file with one owner/mission round and the given pending cards. */
async function seedSession(
  commands: readonly ChatCommand[],
  title = 'Triage',
): Promise<{ readonly file: string; readonly text: string }> {
  let text = newSessionText(title, new Date('2026-11-02T08:00:00Z'));
  text = appendOwner(text, new Date('2026-11-02T08:01:00Z'), 'Please tidy the board');
  text = appendMission(text, new Date('2026-11-02T08:01:30Z'), 'Here is what I propose.', 'Thinking it over');
  for (const command of commands) {
    const summary =
      command.kind === 'transition'
        ? `Move ${command.id} from ${command.from} to ${command.to}`
        : command.kind === 'createTicket'
          ? `Create ticket "${command.title}" in ${command.phase}`
          : command.kind === 'promote'
            ? `Promote ${command.id} to a ship ticket`
            : command.kind === 'setChain'
              ? command.chain.length === 0
                ? `Return ${command.id} to the standard flow`
                : `Set ${command.id} chain to ${command.chain.length} ${command.chain.length === 1 ? 'entry' : 'entries'}`
              : `Set ${command.id} priority to ${command.priority}`;
    text = appendProposal(text, new Date('2026-11-02T08:02:00Z'), summary, command).text;
  }
  const file = `tickets/_meta/chat/20261102-080000-${sessionSlug(title)}.md`;
  await fsp.mkdir(path.dirname(path.join(vaultPath, file)), { recursive: true });
  await fsp.writeFile(path.join(vaultPath, file), text, 'utf8');
  return { file, text };
}

async function readOnDisk(file: string): Promise<string> {
  return fsp.readFile(path.join(vaultPath, file), 'utf8');
}

function resultProposal(): ChatProposal {
  return {
    id: 'p-1',
    state: 'pending',
    summary: 'Move T-0086 from build to review',
    command: TRANSITION,
    at: '2026-11-02T09:00:00Z',
    decidedAt: null,
    outcome: null,
  };
}

describe('ChatService start and send', () => {
  it('starts a session: mints the file, commits it, runs the first turn as one commit', async () => {
    service = boot();
    bridgeReply = { say: 'Done.', thought: 'Checking the board', commands: [TRANSITION] };

    const result = await service.start({ title: 'Costs export', text: 'Move T-0086 to review please' });

    expect(result.ok).toBe(true);
    const file = result.file!;
    expect(file).toMatch(/^tickets\/_meta\/chat\/\d{8}-\d{6}-costs-export\.md$/);
    expect(result.say).toBe('Done.');
    expect(result.thought).toBe('Checking the board');
    expect(result.proposals).toEqual([
      {
        id: 'p-1',
        state: 'pending',
        summary: 'Move T-0086 from build to review',
        command: TRANSITION,
        at: expect.any(String),
        decidedAt: null,
        outcome: null,
      },
    ]);

    expect(commits).toEqual([
      { root: vaultPath, paths: [file], message: `tickets: chat started ${file}` },
      { root: vaultPath, paths: [file], message: `tickets: chat ${file}` },
      { root: vaultPath, paths: [file], message: `tickets: chat ${file}` },
    ]);
    expect(announced).toEqual([file, file, file]);

    const text = await readOnDisk(file);
    expect(text).toContain('title: "Costs export"');
    expect(text).toContain("'2026-11-02T09:00:01.000Z' owner — Move T-0086 to review please");
    expect(text).toContain("'2026-11-02T09:00:02.000Z' thought — Checking the board");
    expect(text).toContain("'2026-11-02T09:00:02.000Z' mission — Done.");
    expect(text).toContain('- \'2026-11-02T09:00:02.000Z\' proposal p-1 pending — Move T-0086 from build to review');
    expect(text).toContain('{"kind":"transition","id":"T-0086","from":"build","to":"review"}');

    const session = parseSessionFile(text, file)!;
    expect(session.messages.map((m) => m.role)).toEqual(['owner', 'mission']);
    expect(session.messages[1]!.thought).toBe('Checking the board');
    expect(session.proposals).toHaveLength(1);
  });

  it('derives the title from the first message when none is given', async () => {
    service = boot();

    const result = await service.start({ text: 'Ship the chat engine today' });

    expect(result.ok).toBe(true);
    expect(result.file!).toMatch(/-ship-the-chat-engine-today\.md$/);
    expect(await readOnDisk(result.file!)).toContain('title: "Ship the chat engine today"');
  });

  it('send appends the owner line and the turn block — one commit per round, ids minted in order', async () => {
    service = boot();

    const started = await service.start({ title: 'Two cards', text: 'First question' });
    const file = started.file!;
    bridgeReply = { say: 'Two proposals.', thought: null, commands: [TRANSITION, SET_PRIORITY] };
    const sent = await service.send({ file, text: 'And now both changes' });

    expect(sent.ok).toBe(true);
    expect(sent.proposals!.map((p) => p.id)).toEqual(['p-1', 'p-2']);
    expect(sent.proposals![1]!.summary).toBe('Set T-0086 priority to urgent');
    expect(commits).toHaveLength(5);
    expect(commits.slice(3)).toEqual([
      { root: vaultPath, paths: [file], message: `tickets: chat ${file}` },
      { root: vaultPath, paths: [file], message: `tickets: chat ${file}` },
    ]);

    const text = await readOnDisk(file);
    expect(text).toContain("'2026-11-02T09:00:01.000Z' owner — First question");
    expect(text).toContain("'2026-11-02T09:00:03.000Z' owner — And now both changes");
    expect(text.indexOf('owner — First question')).toBeLessThan(text.indexOf('mission — Understood.'));
    expect(text.indexOf('owner — And now both changes')).toBeLessThan(text.indexOf('proposal p-1 pending'));
    expect(text.indexOf('proposal p-1 pending')).toBeLessThan(text.indexOf('proposal p-2 pending'));
    // The reader round-trips the whole session.
    const session = parseSessionFile(text, file)!;
    expect(session.proposals.map((p) => p.state)).toEqual(['pending', 'pending']);
  });

  it('a promote command from the mission renders as the promote proposal card', async () => {
    service = boot();
    bridgeReply = { say: 'The scout report is ready — promoting it.', thought: null, commands: [PROMOTE] };

    const result = await service.start({ title: 'Promote', text: 'promote T-0086' });

    expect(result.ok).toBe(true);
    expect(result.proposals).toEqual([
      {
        id: 'p-1',
        state: 'pending',
        summary: 'Promote T-0086 to a ship ticket',
        command: PROMOTE,
        at: expect.any(String),
        decidedAt: null,
        outcome: null,
      },
    ]);
    const text = await readOnDisk(result.file!);
    expect(text).toContain('- \'2026-11-02T09:00:02.000Z\' proposal p-1 pending — Promote T-0086 to a ship ticket');
    expect(text).toContain('{"kind":"promote","id":"T-0086"}');
    // The card is a proposal only — the board port has not been asked yet.
    expect(boardForms).toEqual([]);
  });

  it('a setChain command from the mission renders as the chain proposal card', async () => {
    service = boot();
    bridgeReply = { say: 'Here is the new chain.', thought: null, commands: [SET_CHAIN] };

    const result = await service.start({ title: 'Chain', text: 'insert a design gate after review' });

    expect(result.ok).toBe(true);
    expect(result.proposals).toEqual([
      {
        id: 'p-1',
        state: 'pending',
        summary: 'Set T-0086 chain to 2 entries',
        command: SET_CHAIN,
        at: expect.any(String),
        decidedAt: null,
        outcome: null,
      },
    ]);
    const text = await readOnDisk(result.file!);
    expect(text).toContain('- \'2026-11-02T09:00:02.000Z\' proposal p-1 pending — Set T-0086 chain to 2 entries');
    expect(text).toContain('{"kind":"setChain","id":"T-0086","chain":["insert design(pia, notify) after review","skip verify"]}');
    // The card is a proposal only — the board port has not been asked yet.
    expect(boardChains).toEqual([]);
  });

  it('an empty setChain chain renders as the return-to-standard card', async () => {
    service = boot();
    bridgeReply = { say: 'Back to the standard flow.', thought: null, commands: [RETURN_TO_STANDARD] };

    const result = await service.start({ title: 'Standard', text: 'drop the chain changes' });

    expect(result.ok).toBe(true);
    expect(result.proposals).toEqual([
      {
        id: 'p-1',
        state: 'pending',
        summary: 'Return T-0086 to the standard flow',
        command: RETURN_TO_STANDARD,
        at: expect.any(String),
        decidedAt: null,
        outcome: null,
      },
    ]);
    expect(await readOnDisk(result.file!)).toContain(
      'proposal p-1 pending — Return T-0086 to the standard flow',
    );
  });

  it('hands the bridge the recent history and a board digest of open tickets', async () => {
    service = boot();

    const started = await service.start({ title: 'Digest', text: 'What needs attention?' });
    const file = started.file!;

    expect(bridgeInputs).toHaveLength(1);
    expect(bridgeInputs[0]!.text).toBe('What needs attention?');
    expect(bridgeInputs[0]!.history).toEqual([]);
    const digest = bridgeInputs[0]!.board;
    expect(digest).toContain('columns: inbox (0) → build (1) → review (0) → done (1)');
    expect(digest).toContain('- T-0086 "Fix the CSV export" — build');
    expect(digest).not.toContain('T-0071');

    await service.send({ file, text: 'And now?' });
    expect(bridgeInputs[1]!.history).toEqual([
      { role: 'owner', text: 'What needs attention?' },
      { role: 'mission', text: 'Understood.' },
    ]);
  });

  it('caps the history at the last 20 messages', async () => {
    const { file } = await seedSession([], 'Long history');
    for (let i = 0; i < 25; i++) {
      const text = await readOnDisk(file);
      await fsp.writeFile(path.join(vaultPath, file), appendOwner(text, new Date(2026, 10, 2, 8, 3 + i), `msg-${i}`), 'utf8');
    }
    service = boot();

    await service.send({ file, text: 'Still there?' });

    const history = bridgeInputs[0]!.history;
    expect(history).toHaveLength(20);
    expect(history[0]).toEqual({ role: 'owner', text: 'msg-5' });
    expect(history[19]).toEqual({ role: 'owner', text: 'msg-24' });
  });

  it('caps the board digest near 2 KB and says what did not fit', async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      id: `T-${String(1_000 + i)}`,
      path: `tickets/20-build/T-${String(1_000 + i)}.md`,
      phase: 'build',
      meta: { title: `Ticket number ${i} with a rather descriptive title attached` },
    }));
    boardSnapshot = makeSnapshot({
      columns: [
        { phase: { id: 'inbox' }, tickets: [], unknown: false },
        { phase: { id: 'build' }, tickets: many, unknown: false },
        { phase: { id: 'done' }, tickets: [], unknown: false },
      ],
    });
    service = boot();

    await service.start({ title: 'Big board', text: 'Overview please' });

    const digest = bridgeInputs[0]!.board;
    expect(digest.length).toBeLessThanOrEqual(DIGEST_CAP);
    expect(digest).toContain('… ');
    expect(digest).not.toContain('T-1199');
  });

  it('forwards every stream event in order, tagged with the session file', async () => {
    service = boot();
    scriptedEvents = [
      { kind: 'thought', text: 'Hmm' },
      { kind: 'text', text: 'Moving' },
      { kind: 'proposal', proposal: resultProposal() },
      { kind: 'done' },
    ];
    bridgeReply = { say: 'Moving.', thought: null, commands: [] };

    const result = await service.start({ title: 'Stream', text: 'Go' });

    expect(events.map((e) => e.event.kind)).toEqual(['thought', 'text', 'proposal', 'done']);
    expect(events.every((e) => e.file === result.file)).toBe(true);
    expect(events[2]!.event).toEqual({ kind: 'proposal', proposal: resultProposal() });
  });

  it('refuses a second send while a turn is in flight — then runs it after', async () => {
    let release: ((reply: BridgeReply) => void) | null = null;
    let gated = false;
    bridgeGate = () =>
      gated
        ? new Promise<BridgeReply>((resolve) => {
            release = resolve;
          })
        : Promise.resolve({ say: 'First answer.', thought: null, commands: [] });
    service = boot();
    const started = await service.start({ title: 'Gate', text: 'One' });
    const file = started.file!;
    bridgeRuns = 0;
    gated = true;

    const first = service.send({ file, text: 'Two' });
    const second = await service.send({ file, text: 'Three' });
    await waitFor(() => bridgeRuns === 1);
    expect(second).toEqual({
      ok: false,
      error: `${file} already has a mission turn in flight — wait for it to finish`,
    });

    release!({ say: 'Second answer.', thought: null, commands: [] });
    await expect(first).resolves.toMatchObject({ ok: true, say: 'Second answer.' });
    const text = await readOnDisk(file);
    expect(text).toContain('owner — Two');
    expect(text).toContain('mission — Second answer.');
    expect(text).not.toContain('Three');
  });

  it('a crashed turn reports the error, commits only the owner line and writes no half-turn', async () => {
    let crash = false;
    bridgeGate = () =>
      crash
        ? Promise.reject(new Error('the provider is down'))
        : Promise.resolve({ say: 'First answer.', thought: null, commands: [] });
    service = boot();
    const started = await service.start({ title: 'Crash', text: 'One' });
    const file = started.file!;
    crash = true;

    const result = await service.send({ file, text: 'Two' });

    expect(result).toEqual({ ok: false, error: 'the provider is down', file });
    expect(events[events.length - 1]).toEqual({ file, event: { kind: 'error', message: 'the provider is down' } });
    expect(commits).toHaveLength(4);
    expect(commits[3]).toEqual({ root: vaultPath, paths: [file], message: `tickets: chat ${file}` });
    const text = await readOnDisk(file);
    expect(text).toContain('owner — Two');
    // Start's mission line stands, the crashed turn added nothing.
    expect(parseSessionFile(text, file)!.messages.map((m) => m.role)).toEqual(['owner', 'mission', 'owner']);
  });

  it('refuses an empty message and a missing file without touching the vault', async () => {
    service = boot();
    const started = await service.start({ title: 'Refusals', text: 'One' });
    const file = started.file!;

    expect(await service.send({ file, text: '   ' })).toEqual({ ok: false, error: 'the message is empty' });
    expect(await service.send({ file: 'tickets/_meta/chat/nope.md', text: 'Hi' })).toEqual({
      ok: false,
      error: 'tickets/_meta/chat/nope.md does not exist',
      file: 'tickets/_meta/chat/nope.md',
    });
    expect(commits).toHaveLength(3);
  });
});

describe('ChatService confirm and dismiss', () => {
  it('confirm executes the transition with the actor and records the moved path', async () => {
    const { file } = await seedSession([TRANSITION]);
    service = boot();

    const result = await service.confirm({ file, id: 'p-1' });

    expect(result.ok).toBe(true);
    expect(boardTransitions).toEqual([{ id: 'T-0086', from: 'build', to: 'review', actor: ACTOR }]);
    expect(result.proposal).toMatchObject({
      id: 'p-1',
      state: 'confirmed',
      summary: 'Move T-0086 from build to review',
      outcome: 'tickets/30-review/T-0086.md',
      decidedAt: expect.any(String),
    });
    expect(commits).toEqual([{ root: vaultPath, paths: [file], message: `tickets: chat ${file}` }]);
    const text = await readOnDisk(file);
    expect(text).toContain(
      "- '2026-11-02T09:00:00.000Z' proposal p-1 confirmed — Move T-0086 from build to review → tickets/30-review/T-0086.md",
    );
    // The pending card and its command block stay as history.
    expect(text).toContain('proposal p-1 pending — Move T-0086 from build to review');
  });

  it('confirm on a create executes with the actor — first-phase cards need no transition', async () => {
    const { file } = await seedSession([CREATE_IN_INBOX]);
    service = boot();

    const result = await service.confirm({ file, id: 'p-1' });

    expect(result.ok).toBe(true);
    expect(boardCreates).toEqual([
      {
        title: 'Fix the CSV export',
        description: 'The export drops a column.',
        priority: 'high',
        repo: null,
        actor: ACTOR,
      },
    ]);
    expect(boardTransitions).toEqual([]);
    expect(result.proposal).toMatchObject({ state: 'confirmed', outcome: 'T-0103' });
    expect(await readOnDisk(file)).toContain('proposal p-1 confirmed — Create ticket "Fix the CSV export" in inbox → T-0103');
  });

  it('confirm walks a created card to the phase the card named', async () => {
    const { file } = await seedSession([CREATE_IN_BUILD]);
    service = boot();

    const result = await service.confirm({ file, id: 'p-1' });

    expect(result.ok).toBe(true);
    expect(boardCreates).toHaveLength(1);
    expect(boardTransitions).toEqual([{ id: 'T-0103', from: 'inbox', to: 'build', actor: ACTOR }]);
    expect(result.proposal).toMatchObject({ state: 'confirmed', outcome: 'T-0103' });
  });

  it('confirm on a setPriority records ok as the outcome', async () => {
    const { file } = await seedSession([SET_PRIORITY]);
    service = boot();

    const result = await service.confirm({ file, id: 'p-1' });

    expect(result.ok).toBe(true);
    expect(boardPriorities).toEqual([{ id: 'T-0086', priority: 'urgent', actor: ACTOR }]);
    expect(result.proposal).toMatchObject({ state: 'confirmed', outcome: 'ok' });
    expect(await readOnDisk(file)).toContain('proposal p-1 confirmed — Set T-0086 priority to urgent → ok');
  });

  it('confirm on a promote executes setForm(ship) with the actor and records ok as the outcome', async () => {
    const { file } = await seedSession([PROMOTE]);
    service = boot();

    const result = await service.confirm({ file, id: 'p-1' });

    expect(result.ok).toBe(true);
    expect(boardForms).toEqual([{ id: 'T-0086', form: 'ship', actor: ACTOR }]);
    expect(boardTransitions).toEqual([]);
    expect(boardCreates).toEqual([]);
    expect(result.proposal).toMatchObject({
      id: 'p-1',
      state: 'confirmed',
      summary: 'Promote T-0086 to a ship ticket',
      outcome: 'ok',
      decidedAt: expect.any(String),
    });
    const text = await readOnDisk(file);
    expect(text).toContain("- '2026-11-02T09:00:00.000Z' proposal p-1 confirmed — Promote T-0086 to a ship ticket → ok");
    // The pending card and its command block stay as history.
    expect(text).toContain('proposal p-1 pending — Promote T-0086 to a ship ticket');
  });

  it('confirm on a setChain executes with the actor and records ok as the outcome', async () => {
    const { file } = await seedSession([SET_CHAIN]);
    service = boot();

    const result = await service.confirm({ file, id: 'p-1' });

    expect(result.ok).toBe(true);
    expect(boardChains).toEqual([{ id: 'T-0086', chain: SET_CHAIN.chain, actor: ACTOR }]);
    expect(boardTransitions).toEqual([]);
    expect(result.proposal).toMatchObject({
      id: 'p-1',
      state: 'confirmed',
      summary: 'Set T-0086 chain to 2 entries',
      outcome: 'ok',
      decidedAt: expect.any(String),
    });
    const text = await readOnDisk(file);
    expect(text).toContain("- '2026-11-02T09:00:00.000Z' proposal p-1 confirmed — Set T-0086 chain to 2 entries → ok");
    // The pending card and its command block stay as history.
    expect(text).toContain('proposal p-1 pending — Set T-0086 chain to 2 entries');
  });

  it('confirm on a return-to-standard setChain executes with an empty chain', async () => {
    const { file } = await seedSession([RETURN_TO_STANDARD]);
    service = boot();

    const result = await service.confirm({ file, id: 'p-1' });

    expect(result.ok).toBe(true);
    expect(boardChains).toEqual([{ id: 'T-0086', chain: [], actor: ACTOR }]);
    expect(result.proposal).toMatchObject({ state: 'confirmed', outcome: 'ok' });
    expect(await readOnDisk(file)).toContain('proposal p-1 confirmed — Return T-0086 to the standard flow → ok');
  });

  it('a failed setChain execution leaves the proposal pending and writes no decision', async () => {
    const { file, text } = await seedSession([SET_CHAIN]);
    boardSetChainResult = { ok: false, error: 'the pipeline has no phase "design"' };
    service = boot();

    const result = await service.confirm({ file, id: 'p-1' });

    expect(result).toEqual({ ok: false, error: 'the pipeline has no phase "design"' });
    expect(await readOnDisk(file)).toBe(text);
    expect(commits).toEqual([]);
  });

  it('a failed promote execution leaves the proposal pending and writes no decision', async () => {
    const { file, text } = await seedSession([PROMOTE]);
    boardSetFormResult = { ok: false, error: 'A run is live on this ticket. Change the form when the run has ended.' };
    service = boot();

    const result = await service.confirm({ file, id: 'p-1' });

    expect(result).toEqual({
      ok: false,
      error: 'A run is live on this ticket. Change the form when the run has ended.',
    });
    expect(await readOnDisk(file)).toBe(text);
    expect(commits).toEqual([]);
  });

  it('a failed execution leaves the proposal pending and writes no decision', async () => {
    const { file, text } = await seedSession([TRANSITION]);
    boardTransitionResult = { ok: false, error: 'T-0086 is not in "build" — it may have moved; refresh the board' };
    service = boot();

    const result = await service.confirm({ file, id: 'p-1' });

    expect(result).toEqual({ ok: false, error: 'T-0086 is not in "build" — it may have moved; refresh the board' });
    expect(await readOnDisk(file)).toBe(text);
    expect(commits).toEqual([]);
  });

  it('dismiss records the decision without executing anything', async () => {
    const { file } = await seedSession([TRANSITION]);
    service = boot();

    const result = await service.dismiss({ file, id: 'p-1' });

    expect(result.ok).toBe(true);
    expect(boardTransitions).toEqual([]);
    expect(boardCreates).toEqual([]);
    expect(boardPriorities).toEqual([]);
    expect(boardForms).toEqual([]);
    expect(result.proposal).toMatchObject({ state: 'dismissed', outcome: null });
    const text = await readOnDisk(file);
    expect(text).toContain("'2026-11-02T09:00:00.000Z' proposal p-1 dismissed — Move T-0086 from build to review");
    expect(text).not.toContain('→');
    expect(commits).toEqual([{ root: vaultPath, paths: [file], message: `tickets: chat ${file}` }]);
  });

  it('dismiss on a setChain records the decision without executing anything', async () => {
    const { file } = await seedSession([SET_CHAIN]);
    service = boot();

    const result = await service.dismiss({ file, id: 'p-1' });

    expect(result.ok).toBe(true);
    expect(boardChains).toEqual([]);
    expect(result.proposal).toMatchObject({ state: 'dismissed', outcome: null });
    const text = await readOnDisk(file);
    expect(text).toContain('proposal p-1 dismissed — Set T-0086 chain to 2 entries');
    expect(text).not.toContain('→');
  });

  it('refuses unknown and already-decided proposal ids', async () => {
    const { file } = await seedSession([TRANSITION]);
    service = boot();

    expect(await service.confirm({ file, id: 'p-9' })).toEqual({ ok: false, error: `${file} has no proposal p-9` });

    expect((await service.dismiss({ file, id: 'p-1' })).ok).toBe(true);
    expect(await service.dismiss({ file, id: 'p-1' })).toEqual({
      ok: false,
      error: 'proposal p-1 was already dismissed',
    });
    expect(await service.confirm({ file, id: 'p-1' })).toEqual({
      ok: false,
      error: 'proposal p-1 was already dismissed',
    });
    expect(commits).toEqual([{ root: vaultPath, paths: [file], message: `tickets: chat ${file}` }]);
  });

  it('refuses a decision when the board or the file is gone', async () => {
    service = boot();
    expect(await service.confirm({ file: 'tickets/_meta/chat/x.md', id: 'p-1' })).toEqual({
      ok: false,
      error: 'tickets/_meta/chat/x.md does not exist',
    });
    boardSnapshot = makeSnapshot({ vaultId: null });
    const { file } = await seedSession([TRANSITION]);
    expect(await service.confirm({ file, id: 'p-1' })).toEqual({ ok: false, error: 'no tickets vault detected' });
    expect(commits).toEqual([]);
  });
});

describe('ChatService sessions and open', () => {
  it('lists sessions newest first with pending counts, titles and stamps', async () => {
    const older = await seedSession([TRANSITION, SET_PRIORITY], 'Older chat');
    // Decide one of the two cards: the listing must count exactly one pending.
    const olderText = await readOnDisk(older.file);
    await fsp.writeFile(
      path.join(vaultPath, older.file),
      decideProposal(olderText, new Date('2026-11-02T08:05:00Z'), 'p-2', 'dismissed', null)!,
      'utf8',
    );
    const newer = await seedSession([TRANSITION], 'Newer chat');
    await fsp.utimes(path.join(vaultPath, older.file), new Date('2026-11-01T07:00:00Z'), new Date('2026-11-01T07:00:00Z'));
    await fsp.utimes(path.join(vaultPath, newer.file), new Date('2026-11-02T07:00:00Z'), new Date('2026-11-02T07:00:00Z'));
    service = boot();

    const listed = await service.sessions();

    expect(listed.map((m) => m.file)).toEqual([newer.file, older.file]);
    expect(listed[0]).toEqual({
      file: newer.file,
      title: 'Newer chat',
      createdAt: '2026-11-02T08:00:00.000Z',
      updatedAt: '2026-11-02T07:00:00.000Z',
      pending: 1,
    });
    expect(listed[1]).toMatchObject({ title: 'Older chat', pending: 1 });
  });

  it('returns an empty listing without a board vault', async () => {
    boardSnapshot = makeSnapshot({ vaultId: null });
    service = boot();
    expect(await service.sessions()).toEqual([]);
    expect(await service.open('tickets/_meta/chat/whatever.md')).toBeNull();
  });

  it('open parses a session from disk and forgives a missing or foreign file', async () => {
    const { file } = await seedSession([TRANSITION], 'Readable');
    service = boot();

    const session = await service.open(file);
    expect(session).toMatchObject({ file, title: 'Readable' });
    expect(session!.messages).toHaveLength(2);
    expect(session!.proposals.map((p) => p.state)).toEqual(['pending']);

    expect(await service.open('tickets/_meta/chat/gone.md')).toBeNull();
    const foreign = 'tickets/_meta/chat/20261102-080000-foreign.md';
    await fsp.writeFile(path.join(vaultPath, foreign), 'just prose, no frontmatter\n', 'utf8');
    expect(await service.open(foreign)).toBeNull();
  });
});
