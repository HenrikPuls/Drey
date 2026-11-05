import { promises as fsp, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatBridge, ChatStreamEvent } from '../contracts/chat';
import type { BoardSnapshot } from '../contracts/tickets';
import type { TicketsGit } from '../core/tickets-git';
import { ChatService, type ChatBoardPort } from './chat-service';
import type { EngineHost } from './host';

/**
 * D-7a: the chat answered "not in the current board excerpt" for a ticket
 * that exists. The digest lists open tickets only (never the terminal
 * column, capped near 2 KB) — a done, archived or beyond-the-cap ticket is
 * invisible to the model. A ticket the owner NAMES (T-0091, t-91, #91) is
 * read on demand and handed to the model as a block of its own.
 */

const FILLER = Array.from({ length: 200 }, (_, i) => ({
  id: `T-${String(1_000 + i)}`,
  path: `tickets/20-build/T-${String(1_000 + i)}.md`,
  phase: 'build',
  meta: { title: `Filler ticket number ${i} with a rather descriptive title attached` },
}));

const FILES: Record<string, string> = {
  'T-0091': '---\nid: T-0091\ntitle: Shipped long ago\n---\n\n## Description\n\nThe DONE ticket body.\n',
  'T-0150': '---\nid: T-0150\ntitle: Archived idea\n---\n\n## Description\n\nThe ARCHIVED ticket body.\n',
  'T-1199': '---\nid: T-1199\ntitle: Beyond the digest\n---\n\n## Description\n\nThe BEYOND-THE-CAP ticket body.\n',
};

let root: string;
let vaultPath: string;
let bridgeInputs: { text: string; board: string; named?: string }[];
let reads: string[];
let comments: Record<string, readonly { author: string; at: string; text: string }[]>;
let service: ChatService;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(tmpdir(), 'chat-named-'));
  vaultPath = path.join(root, 'vault');
  await fsp.mkdir(vaultPath, { recursive: true });
  bridgeInputs = [];
  reads = [];
  comments = {};
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
          { phase: { id: 'inbox' }, tickets: [], unknown: false },
          { phase: { id: 'build' }, tickets: FILLER, unknown: false },
          {
            phase: { id: 'done' },
            tickets: [{ id: 'T-0091', path: 'tickets/40-done/T-0091.md', phase: 'done', meta: { title: 'Shipped long ago' } }],
            unknown: false,
          },
        ],
      }) as unknown as BoardSnapshot,
    readTicket: async (id: string) => {
      reads.push(id);
      const text = FILES[id];
      return text === undefined ? { ok: false as const, error: `${id} is not on the board` } : { ok: true as const, text, comments: comments[id] };
    },
  } as unknown as ChatBoardPort;
  const bridge = {
    runTurn: async (input: { text: string; board: string; named?: string; emit: (e: ChatStreamEvent) => void }) => {
      bridgeInputs.push({ text: input.text, board: input.board, ...(input.named === undefined ? {} : { named: input.named }) });
      return { say: 'Done.', thought: null, commands: [] };
    },
  } as unknown as ChatBridge;
  const git = { locate: async (p: string) => ({ root: p, prefix: '' }), commitPaths: async () => undefined } as unknown as TicketsGit;
  let clock = Date.parse('2026-11-05T09:00:00Z');
  return new ChatService({
    host,
    board,
    bridge,
    actor: 'owner@desk',
    log: () => undefined,
    onEvent: () => undefined,
    now: () => new Date((clock += 1000)),
    git,
  });
}

describe('tickets the owner names reach the model (D-7a)', () => {
  it('attaches a done ticket, however the id is typed', async () => {
    for (const typed of ['What is T-0091?', 'and t-91?', 'status of #91']) {
      bridgeInputs = [];
      await service.start({ text: typed });
      expect(bridgeInputs[0]!.board).not.toContain('T-0091'); // the digest never lists the terminal column
      expect(bridgeInputs[0]!.named).toContain('### T-0091');
      expect(bridgeInputs[0]!.named).toContain('The DONE ticket body.');
    }
  });

  it('attaches a ticket beyond the digest cap and an archived one', async () => {
    await service.start({ text: 'Compare T-1199 with T-0150 please' });
    const digest = bridgeInputs[0]!.board;
    expect(digest).not.toContain('T-1199');
    expect(bridgeInputs[0]!.named).toContain('The BEYOND-THE-CAP ticket body.');
    expect(bridgeInputs[0]!.named).toContain('The ARCHIVED ticket body.');
  });

  it('carries the ticket thread (comments) after the document', async () => {
    comments['T-0091'] = [{ author: 'ben@fleet', at: '2026-11-01T10:00:00Z', text: 'Merged as abc123.' }];
    await service.start({ text: 'T-0091?' });
    const named = bridgeInputs[0]!.named!;
    expect(named.indexOf('The DONE ticket body.')).toBeLessThan(named.indexOf('Merged as abc123.'));
    expect(named).toContain('ben@fleet');
  });

  it('says plainly when a named ticket does not exist, so the model never guesses', async () => {
    await service.start({ text: 'what about T-9999?' });
    expect(bridgeInputs[0]!.named).toContain('T-9999');
    expect(bridgeInputs[0]!.named).toContain('is not on the board');
  });

  it('sends nothing when no ticket is named, and keeps the ticket of a follow-up question', async () => {
    const started = await service.start({ text: 'How is the board?' });
    expect(bridgeInputs[0]!.named).toBeUndefined();
    expect(reads).toEqual([]);
    await service.send({ file: started.file!, text: 'Tell me about T-0091' });
    await service.send({ file: started.file!, text: 'and who merged it?' });
    expect(bridgeInputs[2]!.named).toContain('The DONE ticket body.');
  });

  it('cuts one huge ticket instead of flooding the prompt', async () => {
    FILES['T-0091'] = `---\nid: T-0091\n---\n\n${'x'.repeat(60_000)}\n`;
    await service.start({ text: 'T-0091' });
    expect(bridgeInputs[0]!.named!.length).toBeLessThan(20_000);
    expect(bridgeInputs[0]!.named).toContain('(cut)');
  });

  it('tells the model in the digest that closed tickets are read by id', async () => {
    await service.start({ text: 'overview' });
    expect(bridgeInputs[0]!.board).toMatch(/done.*by id|by id/i);
  });
});
