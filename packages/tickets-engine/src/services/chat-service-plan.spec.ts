import { promises as fsp, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatBridge, ChatStreamEvent } from '../contracts/chat';
import type { BoardSnapshot } from '../contracts/tickets';
import { appendPlanEdit, newSessionText, parseSessionFile } from '../core/chat-session';
import type { TicketsGit } from '../core/tickets-git';
import { ChatService, type ChatBoardPort } from './chat-service';
import type { EngineHost } from './host';
import { MemoryPlanShadowStore } from './plan-shadow';

/**
 * E10-2: the shared plan in a shape session. The owner edits the ticket's
 * Plan between messages; only that delta goes to the model and into the
 * history as a "You edited the plan" card, the model's own edits never
 * come back, and the status feeds the chip and the line marks.
 */

const TICKET = 'T-0130';
const plan = (body: string): string => `---\nid: ${TICKET}\n---\n\n## Description\n\nx\n\n## Plan\n\n${body}\n\n## Log\n\n- one\n`;

let root: string;
let vaultPath: string;
let ticketText: string;
let bridgeInputs: { text: string; planDelta?: string; reference?: string }[];
let onTurn: (() => void) | null;
let shadows: MemoryPlanShadowStore;
let clock: number;
let service: ChatService;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(tmpdir(), 'chat-plan-'));
  vaultPath = path.join(root, 'vault');
  await fsp.mkdir(vaultPath, { recursive: true });
  ticketText = plan('Goal\n- one');
  bridgeInputs = [];
  onTurn = null;
  shadows = new MemoryPlanShadowStore();
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
        pipeline: [{ id: 'inbox' }],
        priorities: { order: ['normal'], default: 'normal' },
        columns: [{ phase: { id: 'inbox' }, tickets: [], unknown: false }],
      }) as unknown as BoardSnapshot,
    readTicket: async (id: string) => (id === TICKET ? { ok: true as const, text: ticketText } : { ok: false as const, error: 'nope' }),
  } as unknown as ChatBoardPort;
  const bridge = {
    runTurn: async (input: { text: string; planDelta?: string; reference?: string; emit: (e: ChatStreamEvent) => void }) => {
      bridgeInputs.push({ text: input.text, ...(input.planDelta === undefined ? {} : { planDelta: input.planDelta }), ...(input.reference === undefined ? {} : { reference: input.reference }) });
      onTurn?.();
      return { say: 'Done.', thought: null, commands: [] };
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
    shadows,
  });
}

describe('the shared plan in a shape session', () => {
  it('records which ticket a session shapes', async () => {
    const started = await service.start({ title: 'Shape', text: 'Start', ticket: TICKET });
    const session = parseSessionFile(await fsp.readFile(path.join(vaultPath, started.file!), 'utf8'), started.file!);
    expect(session?.ticket).toBe(TICKET);
    expect(parseSessionFile(newSessionText('Plain', new Date()), 'x.md')?.ticket).toBeNull();
  });

  it('hands the desktop reference text to the model for that turn only', async () => {
    const started = await service.start({ text: 'Start', ticket: TICKET, context: 'VAULT CONTEXT [1] arch/doc.md' });
    expect(bridgeInputs[0]!.reference).toBe('VAULT CONTEXT [1] arch/doc.md');
    await service.send({ file: started.file!, text: 'Next' });
    expect(bridgeInputs[1]!.reference).toBeUndefined();
    const session = await fsp.readFile(path.join(vaultPath, started.file!), 'utf8');
    expect(session).not.toContain('VAULT CONTEXT');
  });

  it('sends nothing on the first turn (no shadow) and keeps a shadow of the plan after it', async () => {
    const started = await service.start({ text: 'Start', ticket: TICKET });
    expect(bridgeInputs[0]!.planDelta).toBeUndefined();
    expect(await shadows.get(TICKET)).toEqual({ version: 1, text: 'Goal\n- one', modelLines: [], at: expect.any(String) });
    expect(started.ok).toBe(true);
  });

  it('sends only the owner’s edits since the model’s last turn, as a card and as the model’s input', async () => {
    const { file } = await service.start({ text: 'Start', ticket: TICKET });
    ticketText = plan('Goal\n- one\n- two');

    await service.send({ file: file!, text: 'Added a line' });

    expect(bridgeInputs[1]!.planDelta).toContain('1 edit · +1 −0');
    expect(bridgeInputs[1]!.planDelta).toContain('+ - two');
    const session = parseSessionFile(await fsp.readFile(path.join(vaultPath, file!), 'utf8'), file!)!;
    const card = session.messages.find((m) => m.kind === 'plan-edit')!;
    expect(card.text).toBe('1 edit · +1 −0');
    expect(card.diff).toBe('@@ line 3\n+ - two');
    // The card sits before the owner line it belongs to.
    expect(session.messages.map((m) => m.kind ?? m.role)).toEqual(['owner', 'mission', 'plan-edit', 'owner', 'mission']);
    expect((await shadows.get(TICKET))?.version).toBe(2);
  });

  it('does not mirror the model’s own plan edits back, and marks them', async () => {
    const { file } = await service.start({ text: 'Start', ticket: TICKET });
    onTurn = () => {
      ticketText = plan('Goal\n- one\n- by the model');
    };
    await service.send({ file: file!, text: 'Go on' });
    onTurn = null;

    await service.send({ file: file!, text: 'And again' });

    expect(bridgeInputs[2]!.planDelta).toBeUndefined();
    const status = await service.planStatus(TICKET);
    expect(status).toMatchObject({ ok: true, version: 3, edits: 0, summary: null });
  });

  it('leaves the edits out when the chip is deselected, but still moves the shadow on', async () => {
    const { file } = await service.start({ text: 'Start', ticket: TICKET });
    ticketText = plan('Goal\n- one\n- two');

    await service.send({ file: file!, text: 'Quiet change', planEdits: false });

    expect(bridgeInputs[1]!.planDelta).toBeUndefined();
    const session = parseSessionFile(await fsp.readFile(path.join(vaultPath, file!), 'utf8'), file!)!;
    expect(session.messages.some((m) => m.kind === 'plan-edit')).toBe(false);
    expect((await service.planStatus(TICKET)).ok && (await service.planStatus(TICKET))).toMatchObject({ edits: 0 });
  });

  it('reports the chip count and the line marks: yours since the shadow, the model’s from its last turn', async () => {
    const { file } = await service.start({ text: 'Start', ticket: TICKET });
    onTurn = () => {
      ticketText = plan('Goal\n- one\n- by the model');
    };
    await service.send({ file: file!, text: 'Go' });
    onTurn = null;
    ticketText = plan('Goal!\n- one\n- by the model');

    const status = await service.planStatus(TICKET);

    expect(status).toEqual({
      ok: true,
      version: 2,
      modelAt: expect.any(String),
      edits: 1,
      summary: '1 edit · +1 −1',
      marks: [
        { no: 1, text: 'Goal!', by: 'you' },
        { no: 3, text: '- by the model', by: 'model' },
      ],
    });
  });

  it('refuses a ticket it cannot read and needs no shadow to answer', async () => {
    expect(await service.planStatus('T-9999')).toEqual({ ok: false, error: 'T-9999 has no readable plan' });
    expect(await service.planStatus(TICKET)).toEqual({ ok: true, version: null, modelAt: null, edits: 0, summary: null, marks: [] });
  });
});

describe('the plan-edit card in the file', () => {
  it('round-trips through the session reader and stays out of the model’s history', () => {
    const text = appendPlanEdit(newSessionText('Shape', new Date('2026-11-04T09:00:00Z'), TICKET), new Date('2026-11-04T09:01:00Z'), '1 edit · +1 −0', '@@ line 3\n+ - two');
    const session = parseSessionFile(text, 'x.md')!;
    expect(session.messages).toEqual([
      { role: 'owner', text: '1 edit · +1 −0', at: '2026-11-04T09:01:00.000Z', thought: null, kind: 'plan-edit', diff: '@@ line 3\n+ - two' },
    ]);
  });
});
