import { promises as fsp, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatBridge, ChatShapeContext, ChatShapeReply } from '../contracts/chat';
import type { BoardSnapshot } from '../contracts/tickets';
import { parseSessionFile } from '../core/chat-session';
import { withPlanSection } from '../core/plan-section';
import type { TicketsGit } from '../core/tickets-git';
import { ChatService, type ChatBoardPort } from './chat-service';
import type { EngineHost } from './host';
import { MemoryPlanShadowStore } from './plan-shadow';

/**
 * E10-3: Shape mode. Paul's turn writes only the ticket's Plan chapter,
 * asks through answer cards, reads the repository through the board's
 * read-only seam and proposes "Keep as one ticket" / "Split into N
 * tickets" — N counted from the plan's Parts, never a fixed number.
 */

const TICKET = 'T-0130';
const base = `---\nid: ${TICKET}\n---\n\n## Description\n\nVoice capture\n\n## Plan\n\nold plan\n\n## Log\n\n- one\n`;
const TWO_PARTS = '### Goal\n\nCapture by voice.\n\n### Parts\n\n- [ ] Capture window\n  persona: ben\n- [ ] Tidy-up\n  persona: ben\n';

let root: string;
let vaultPath: string;
let ticketText: string;
let reply: ChatShapeReply;
let seen: ChatShapeContext | undefined;
let moves: { id: string; from: string; to: string }[];
let planFails: boolean;
let clock: number;
let service: ChatService;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(tmpdir(), 'chat-shape-'));
  vaultPath = path.join(root, 'vault');
  await fsp.mkdir(vaultPath, { recursive: true });
  ticketText = base;
  reply = { plan: null, question: null, splitReason: null, sources: [] };
  seen = undefined;
  moves = [];
  planFails = false;
  clock = Date.parse('2026-11-04T09:00:00Z');
  service = boot();
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

async function walk(absDir: string, prefix: string, out: string[]): Promise<void> {
  for (const entry of await fsp.readdir(absDir, { withFileTypes: true }).catch(() => [] as Dirent[])) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await walk(path.join(absDir, entry.name), rel, out);
    } else if (entry.name.endsWith('.md')) {
      out.push(rel);
    }
  }
}

function boot(): ChatService {
  const host = {
    listVaults: async () => [{ id: 'vault', name: 'vault', path: vaultPath, exists: true, active: true }],
    read: async (_v: string, p: string) => fsp.readFile(path.join(vaultPath, p), 'utf8'),
    write: async (_v: string, p: string, text: string) => {
      await fsp.mkdir(path.dirname(path.join(vaultPath, p)), { recursive: true });
      await fsp.writeFile(path.join(vaultPath, p), text, 'utf8');
    },
    listMarkdownFiles: async () => {
      const out: string[] = [];
      await walk(vaultPath, '', out);
      return out;
    },
    resolveAssetPath: (_v: string, p: string) => path.join(vaultPath, p),
    announceChanges: () => undefined,
  } as unknown as EngineHost;
  const board = {
    snapshot: async () =>
      ({
        vaultId: 'vault',
        pipeline: [{ id: 'inbox' }, { id: 'build' }, { id: 'done' }],
        priorities: { order: ['normal'], default: 'normal' },
        columns: [
          { phase: { id: 'inbox' }, tickets: [{ id: TICKET, meta: { title: 'Voice' } }], unknown: false },
          { phase: { id: 'build' }, tickets: [], unknown: false },
          { phase: { id: 'done' }, tickets: [], unknown: false },
        ],
      }) as unknown as BoardSnapshot,
    readTicket: async (id: string) => (id === TICKET ? { ok: true as const, text: ticketText } : { ok: false as const, error: 'nope' }),
    setPlan: async (input: { plan: string }) => {
      if (planFails) {
        return { ok: false as const, error: 'a run is live' };
      }
      ticketText = withPlanSection(ticketText, input.plan);
      return { ok: true as const };
    },
    readRepoFile: async (_id: string, p: string) => ({ ok: true as const, text: `contents of ${p}` }),
    transition: async (input: { id: string; from: string; to: string }) => {
      moves.push(input);
      return { ok: true as const, path: 'tickets/30-build/T-0130.md' };
    },
  } as unknown as ChatBoardPort;
  const bridge = {
    runTurn: async (input: { shape?: ChatShapeContext }) => {
      seen = input.shape;
      return { say: 'I wrote the plan.', thought: null, commands: [], ...(input.shape === undefined ? {} : { shape: reply }) };
    },
  } as unknown as ChatBridge;
  const git = { locate: async (p: string) => ({ root: p, prefix: '' }), commitPaths: async () => undefined } as unknown as TicketsGit;
  return new ChatService({
    host,
    board,
    bridge,
    actor: 'owner@desk',
    log: () => undefined,
    onEvent: () => undefined,
    now: () => new Date((clock += 1000)),
    git,
    shadows: new MemoryPlanShadowStore(),
  });
}

async function session(file: string): Promise<ReturnType<typeof parseSessionFile>> {
  return parseSessionFile(await fsp.readFile(path.join(vaultPath, file), 'utf8'), file);
}

describe('a shape turn', () => {
  it('hands the bridge the ticket text and a read-only repository reader', async () => {
    await service.start({ text: 'Shape this', ticket: TICKET });
    expect(seen?.ticket).toBe(TICKET);
    expect(seen?.ticketText).toContain('old plan');
    expect(await seen!.readFile('src/')).toEqual({ ok: true, text: 'contents of src/' });
  });

  it('gives a plain chat no shape context', async () => {
    await service.start({ text: 'Hello' });
    expect(seen).toBeUndefined();
  });

  it('writes the plan chapter and nothing else of the ticket', async () => {
    reply = { ...reply, plan: TWO_PARTS };
    await service.start({ text: 'Shape this', ticket: TICKET });
    expect(ticketText).toContain('## Plan\n\n### Goal');
    expect(ticketText).toContain('## Description\n\nVoice capture');
    expect(ticketText).toContain('## Log\n\n- one');
    expect(ticketText).not.toContain('old plan');
  });

  it('says so when the plan could not be saved and offers no split', async () => {
    planFails = true;
    reply = { ...reply, plan: TWO_PARTS, splitReason: 'Parts ship alone' };
    const turn = await service.start({ text: 'Shape this', ticket: TICKET });
    expect(turn.say).toContain('The plan could not be saved: a run is live');
    const s = (await session(turn.file!))!;
    expect(s.messages.some((m) => m.kind === 'split')).toBe(false);
  });

  it('records the files read and the open question as cards', async () => {
    reply = {
      ...reply,
      sources: ['CLAUDE.md', 'src/capture.ts'],
      question: { text: 'Where should the report live?', options: [{ label: 'docs/', recommended: true }, { label: 'Tickets repo', recommended: false }] },
    };
    const turn = await service.start({ text: 'Shape this', ticket: TICKET });
    const s = (await session(turn.file!))!;
    expect(s.sources).toEqual(['CLAUDE.md', 'src/capture.ts']);
    const question = s.messages.find((m) => m.kind === 'question')!;
    expect(question.text).toBe('Where should the report live?');
    expect(question.options).toEqual([{ label: 'docs/', recommended: true }, { label: 'Tickets repo', recommended: false }]);
  });
});

describe('the split proposal', () => {
  it('counts N from the plan’s parts', async () => {
    reply = { ...reply, plan: TWO_PARTS, splitReason: 'Each part ships and tests on its own' };
    const turn = await service.start({ text: 'Shape this', ticket: TICKET });
    const split = (await session(turn.file!))!.messages.find((m) => m.kind === 'split')!;
    expect(split.parts).toBe(2);
    expect(split.text).toBe('Each part ships and tests on its own');
    expect(split.decision).toBeNull();
  });

  it('counts one for a plan without parts', async () => {
    reply = { ...reply, plan: '### Goal\n\nOne thing.', splitReason: 'A single part' };
    const turn = await service.start({ text: 'Shape this', ticket: TICKET });
    expect((await session(turn.file!))!.messages.find((m) => m.kind === 'split')!.parts).toBe(1);
  });

  it('“Keep as one ticket” moves the ticket into the build queue and records the choice', async () => {
    reply = { ...reply, plan: '### Goal\n\nOne.', splitReason: 'A single part' };
    const turn = await service.start({ text: 'Shape this', ticket: TICKET });
    const decided = await service.shapeDecide({ file: turn.file!, choice: 'keep' });
    expect(decided).toEqual({ ok: true, outcome: 'tickets/30-build/T-0130.md' });
    expect(moves).toEqual([{ id: TICKET, from: 'inbox', to: 'build', actor: 'owner@desk' }]);
    expect((await session(turn.file!))!.messages.find((m) => m.kind === 'split')!.decision).toBe('keep');
  });

  it('“Split into N tickets” only records the choice — nothing moves', async () => {
    reply = { ...reply, plan: TWO_PARTS, splitReason: 'Parts ship alone' };
    const turn = await service.start({ text: 'Shape this', ticket: TICKET });
    expect(await service.shapeDecide({ file: turn.file!, choice: 'split' })).toEqual({ ok: true, outcome: 'split' });
    expect(moves).toEqual([]);
    expect((await session(turn.file!))!.messages.find((m) => m.kind === 'split')!.decision).toBe('split');
  });

  it('decides once and refuses without an open proposal', async () => {
    reply = { ...reply, plan: TWO_PARTS, splitReason: 'Parts ship alone' };
    const turn = await service.start({ text: 'Shape this', ticket: TICKET });
    await service.shapeDecide({ file: turn.file!, choice: 'split' });
    expect((await service.shapeDecide({ file: turn.file!, choice: 'keep' })).ok).toBe(false);
    const plain = await service.start({ text: 'Hello' });
    expect((await service.shapeDecide({ file: plain.file!, choice: 'keep' })).ok).toBe(false);
  });
});
