import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EngineBoardService, type BoardServiceOptions } from './board-service';
import type { EngineHost, EngineVault, FleetPort } from './host';
import { TicketsGit } from '../core/tickets-git';
import { newTicketFileText } from '../core/ticket-files';
import type { LedgerWrite } from '../core/ledger';
import { normalizeFleetCaps, normalizeFleetHandover, normalizeFleetPools } from '../fleet/protocol';

/**
 * E7: the board service's ledger writes and the status read, against a
 * real temp vault — a successful move writes the phase line, a terminal
 * Accept writes archived + merged, an archive writes archived, a refused
 * mutation writes nothing, and `statusOf` reads the ticket's status log
 * tolerant. No git (every commit degrades to the unversioned warning).
 */

const PIPELINE = `---
phases:
  - { id: inbox, title: Inbox, handover: manual }
  - { id: done, title: Done, handover: none }
---
The pipeline.
`;

let vaultDir = '';
let vault: EngineVault;
let ledgerWrites: LedgerWrite[];

beforeEach(async () => {
  vaultDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-board-svc-'));
  vault = { id: 'v', name: 'vault', path: vaultDir, exists: true, active: true };
  ledgerWrites = [];
  await fsp.mkdir(path.join(vaultDir, 'tickets', '_meta'), { recursive: true });
  await fsp.mkdir(path.join(vaultDir, 'tickets', 'inbox'), { recursive: true });
  await fsp.writeFile(path.join(vaultDir, 'tickets', '_meta', 'pipeline.md'), PIPELINE, 'utf8');
});

afterEach(async () => {
  await fsp.rm(vaultDir, { recursive: true, force: true });
});

/** Every markdown file under the vault, vault-relative with forward slashes. */
async function listMarkdownFiles(root: string, dir = ''): Promise<string[]> {
  const abs = dir === '' ? root : path.join(root, dir);
  const out: string[] = [];
  for (const entry of await fsp.readdir(abs, { withFileTypes: true }).catch(() => [])) {
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...(await listMarkdownFiles(root, rel)));
    } else if (entry.name.endsWith('.md')) {
      out.push(rel);
    }
  }
  return out;
}

function hostOf(): EngineHost {
  const abs = (p: string): string => path.join(vaultDir, ...p.split('/'));
  return {
    listVaults: async () => [vault],
    read: async (_vaultId, p) => fsp.readFile(abs(p), 'utf8'),
    writeAnnounced: async (_vaultId, p, text) => {
      await fsp.mkdir(path.dirname(abs(p)), { recursive: true });
      await fsp.writeFile(abs(p), text, 'utf8');
    },
    write: async (_vaultId, p, text) => {
      await fsp.mkdir(path.dirname(abs(p)), { recursive: true });
      await fsp.writeFile(abs(p), text, 'utf8');
    },
    listMarkdownFiles: async () => listMarkdownFiles(vaultDir),
    resolveAssetPath: (_vaultId, p) => abs(p),
    announceChanges: () => undefined,
    markManaged: () => undefined,
    configGet: async () => undefined,
    configSet: async () => undefined,
    emitBoardChanged: () => undefined,
    log: () => undefined,
    userRoot: '/home',
    pickFolder: async () => null,
    revealPath: async () => '',
    launchInConsole: () => undefined,
  };
}

function serviceOf(options: BoardServiceOptions = {}): EngineBoardService {
  // A git whose every command fails: locate() answers null, so the one
  // commit per mutation degrades to the honest unversioned warning.
  const git = new TicketsGit(() => 'git', async () => {
    throw new Error('no git in the spec');
  });
  const fleet: FleetPort = {
    runs: async () => [],
    start: async () => ({ ok: false, error: 'not in the spec' }),
    configureChain: async () => undefined,
  };
  return new EngineBoardService(
    hostOf(),
    git,
    'opencode',
    'accept-edits',
    '',
    fleet,
    '/fleet',
    normalizeFleetCaps({}),
    normalizeFleetPools({}),
    normalizeFleetHandover({}),
    'owner@test',
    options,
  );
}

async function writeTicket(id: string, phase: string): Promise<void> {
  const text = newTicketFileText({
    id,
    title: `Ticket ${id}`,
    repo: null,
    priority: 'normal',
    rank: 5000,
    firstPhase: phase,
    now: new Date('2026-11-02T10:00:00Z'),
    actor: 'owner@test',
    description: 'Do the thing.',
  });
  await fsp.mkdir(path.join(vaultDir, 'tickets', phase), { recursive: true });
  await fsp.writeFile(path.join(vaultDir, 'tickets', phase, `${id}.md`), text, 'utf8');
}

describe('EngineBoardService E7 ledger writes', () => {
  it('a successful move writes the phase line with from and to', async () => {
    await writeTicket('T-0001', 'inbox');
    const service = serviceOf({ events: { ledger: (write) => ledgerWrites.push(write) } });

    const outcome = await service.transition({ id: 'T-0001', from: 'inbox', to: 'done' });

    expect(outcome.ok).toBe(true);
    expect(ledgerWrites).toEqual([{ kind: 'phase', ticket: 'T-0001', from: 'inbox', to: 'done' }]);
    await expect(fsp.access(path.join(vaultDir, 'tickets', 'inbox', 'T-0001.md'))).rejects.toBeDefined();
  });

  it('a refused mutation writes nothing', async () => {
    await writeTicket('T-0001', 'inbox');
    const service = serviceOf({ events: { ledger: (write) => ledgerWrites.push(write) } });

    const outcome = await service.transition({ id: 'T-0001', from: 'done', to: 'inbox' });

    expect(outcome.ok).toBe(false);
    expect(ledgerWrites).toEqual([]);
  });

  it('an archive writes the archived line', async () => {
    await writeTicket('T-0001', 'inbox');
    const service = serviceOf({ events: { ledger: (write) => ledgerWrites.push(write) } });

    const outcome = await service.archive({ id: 'T-0001' });

    expect(outcome.ok).toBe(true);
    expect(ledgerWrites).toEqual([{ kind: 'archived', ticket: 'T-0001' }]);
  });

  it("a terminal Accept writes archived then merged (the ticket's real journey)", async () => {
    await writeTicket('T-0001', 'done'); // the pipeline's terminal phase
    const service = serviceOf({ events: { ledger: (write) => ledgerWrites.push(write) } });

    const outcome = await service.acceptTicket({ id: 'T-0001' });

    expect(outcome.ok).toBe(true);
    expect(ledgerWrites).toEqual([
      { kind: 'archived', ticket: 'T-0001' },
      { kind: 'merged', ticket: 'T-0001' },
    ]);
  });

  it('a non-terminal Accept is an ordinary phase move', async () => {
    await writeTicket('T-0001', 'inbox');
    const service = serviceOf({ events: { ledger: (write) => ledgerWrites.push(write) } });

    const outcome = await service.acceptTicket({ id: 'T-0001' });

    expect(outcome.ok).toBe(true);
    expect(ledgerWrites).toEqual([{ kind: 'phase', ticket: 'T-0001', from: 'inbox', to: 'done' }]);
  });

  it('without events the service stays silent (the pre-E7 construction)', async () => {
    await writeTicket('T-0001', 'inbox');
    const service = serviceOf();
    const outcome = await service.transition({ id: 'T-0001', from: 'inbox', to: 'done' });
    expect(outcome.ok).toBe(true);
    expect(ledgerWrites).toEqual([]);
  });
});

describe('EngineBoardService statusOf', () => {
  it('reads the ticket status log beside its card', async () => {
    await writeTicket('T-0001', 'inbox');
    await fsp.writeFile(
      path.join(vaultDir, 'tickets', 'inbox', 'T-0001.status.log'),
      [
        "- '2026-11-02T09:00:00Z' working: inbox on opus",
        '- not a status line',
        "- '2026-11-02T09:12:00Z' needs-decision: [palette-shortcut] Which shortcut should open the palette?",
        '',
      ].join('\n'),
      'utf8',
    );
    const service = serviceOf();

    const lines = await service.statusOf('T-0001');

    expect(lines).toEqual([
      { at: '2026-11-02T09:00:00Z', verb: 'working', key: null, text: 'inbox on opus' },
      { at: '2026-11-02T09:12:00Z', verb: 'needs-decision', key: 'palette-shortcut', text: 'Which shortcut should open the palette?' },
    ]);
  });

  it('reads empty when the log or the ticket is absent', async () => {
    await writeTicket('T-0001', 'inbox');
    const service = serviceOf();
    await expect(service.statusOf('T-0001')).resolves.toEqual([]);
    await expect(service.statusOf('T-0099')).resolves.toEqual([]);
  });
});
