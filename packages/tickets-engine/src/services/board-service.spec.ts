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
 * tolerant. E8 adds `setForm` (concept §5.6): the scout → ship
 * promotion's board half — the `form:` header flip, the `form <value>`
 * Log line, the no-op when the file already carries the form, the
 * live-run refusal. E9 adds `setChain` (concept §5.7): the chat's chain
 * delta — grammar parse per entry, the semantic guard against the
 * pipeline and the card's phase, the canonical `chain:` header rewrite,
 * the `chain <n entries|standard>` Log line, the no-op on an unchanged
 * delta, the live-run refusal. No git (every commit degrades to the
 * unversioned warning).
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

/** The same ticket with `form: scout` added to the frontmatter. */
async function writeScoutTicket(id: string, phase: string): Promise<void> {
  await writeTicket(id, phase);
  const file = path.join(vaultDir, 'tickets', phase, `${id}.md`);
  const text = await fsp.readFile(file, 'utf8');
  await fsp.writeFile(file, text.replace('priority: normal\n', 'priority: normal\nform: scout\n'), 'utf8');
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

describe('EngineBoardService setForm (E8)', () => {
  it('promoting a scout ticket writes form: ship with the form Log line — the commit degrades to the unversioned warning here', async () => {
    await writeScoutTicket('T-0001', 'inbox');
    const service = serviceOf();

    const outcome = await service.setForm({ id: 'T-0001', form: 'ship', actor: 'owner@test' });

    expect(outcome).toMatchObject({
      ok: true,
      warning: 'the tickets vault is not a git repository — the change is not versioned',
    });
    const text = await fsp.readFile(path.join(vaultDir, 'tickets', 'inbox', 'T-0001.md'), 'utf8');
    expect(text).toContain('form: ship');
    expect(text).not.toContain('form: scout');
    expect(text).toMatch(/- '\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z' owner@test — form ship/);
    // The rest of the file is untouched — description and the creation line stand.
    expect(text).toContain('## Description');
    expect(text).toContain("- '2026-11-02T10:00:00Z' owner@test — created in inbox");
  });

  it('demoting a ship ticket back to scout writes form: scout with the form Log line', async () => {
    await writeTicket('T-0001', 'inbox');
    const service = serviceOf();

    const outcome = await service.setForm({ id: 'T-0001', form: 'scout' });

    expect(outcome.ok).toBe(true);
    const text = await fsp.readFile(path.join(vaultDir, 'tickets', 'inbox', 'T-0001.md'), 'utf8');
    expect(text).toContain('form: scout');
    expect(text).toMatch(/- '\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z' owner@test — form scout/);
  });

  it('setting the form the file already carries is a no-op success — no write, no Log line', async () => {
    await writeTicket('T-0001', 'inbox'); // no form key — the ship default
    const file = path.join(vaultDir, 'tickets', 'inbox', 'T-0001.md');
    const before = await fsp.readFile(file, 'utf8');
    const service = serviceOf();

    const outcome = await service.setForm({ id: 'T-0001', form: 'ship' });

    expect(outcome).toEqual({ ok: true });
    expect(await fsp.readFile(file, 'utf8')).toBe(before);
  });

  it('a live run refuses the form change and leaves the file untouched', async () => {
    await writeScoutTicket('T-0001', 'inbox');
    const file = path.join(vaultDir, 'tickets', 'inbox', 'T-0001.md');
    const text = await fsp.readFile(file, 'utf8');
    await fsp.writeFile(
      file,
      text.replace(
        'branch:',
        "run:\n  pid: 42\n  started-at: '2026-11-02T10:00:00Z'\n  stream: run-1\nbranch:",
      ),
      'utf8',
    );
    const service = serviceOf();

    const outcome = await service.setForm({ id: 'T-0001', form: 'ship' });

    expect(outcome).toEqual({
      ok: false,
      error: 'A run is live on this ticket. Change the form when the run has ended.',
    });
    const after = await fsp.readFile(file, 'utf8');
    expect(after).toContain('form: scout');
    expect(after).not.toMatch(/— form ship/);
  });

  it('refuses a ticket that is not on the board', async () => {
    const service = serviceOf();

    const outcome = await service.setForm({ id: 'T-0099', form: 'ship' });

    expect(outcome).toEqual({ ok: false, error: 'T-0099 is not on the board' });
  });
});

// `setChain` reads the pipeline via the non-enqueueing `snapshot()` (the
// single-writer queue must never be re-entered from inside an op).
describe('EngineBoardService setChain (E9)', () => {
  const CHAIN_PIPELINE = `---
phases:
  - { id: inbox, title: Inbox, handover: manual }
  - { id: build, title: Build, handover: manual }
  - { id: review, title: Review, handover: manual }
  - { id: verify, title: Verify, handover: manual }
  - { id: done, title: Done, handover: none }
---
The pipeline.
`;

  beforeEach(async () => {
    await fsp.writeFile(path.join(vaultDir, 'tickets', '_meta', 'pipeline.md'), CHAIN_PIPELINE, 'utf8');
  });

  /** The same ticket with a `chain:` delta added to the frontmatter. */
  async function writeChainedTicket(id: string, phase: string, chain: readonly string[]): Promise<void> {
    await writeTicket(id, phase);
    const file = path.join(vaultDir, 'tickets', phase, `${id}.md`);
    const text = await fsp.readFile(file, 'utf8');
    const lines = chain.map((entry) => `  - ${entry}`).join('\n');
    await fsp.writeFile(file, text.replace('priority: normal\n', `priority: normal\nchain:\n${lines}\n`), 'utf8');
  }

  it('setting a chain writes the canonical entries with the chain Log line — the commit degrades to the unversioned warning here', async () => {
    await writeTicket('T-0001', 'build');
    const service = serviceOf();

    const outcome = await service.setChain({
      id: 'T-0001',
      chain: ['insert review(pia, notify) after build', 'skip verify'],
      actor: 'owner@test',
    });

    expect(outcome).toMatchObject({
      ok: true,
      warning: 'the tickets vault is not a git repository — the change is not versioned',
    });
    const text = await fsp.readFile(path.join(vaultDir, 'tickets', 'build', 'T-0001.md'), 'utf8');
    expect(text).toContain('chain:\n  - insert review(pia, notify) after build\n  - skip verify');
    expect(text).toMatch(/- '\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z' owner@test — chain 2 entries/);
    // The rest of the file is untouched — description and the creation line stand.
    expect(text).toContain('## Description');
    expect(text).toContain("- '2026-11-02T10:00:00Z' owner@test — created in build");
  });

  it('returning to the standard flow removes the chain key with the chain standard Log line', async () => {
    await writeChainedTicket('T-0001', 'build', ['skip verify']);
    const service = serviceOf();

    const outcome = await service.setChain({ id: 'T-0001', chain: [] });

    expect(outcome.ok).toBe(true);
    const text = await fsp.readFile(path.join(vaultDir, 'tickets', 'build', 'T-0001.md'), 'utf8');
    expect(text).not.toContain('chain:');
    expect(text).toMatch(/- '\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z' owner@test — chain standard/);
  });

  it('setting the chain the file already carries is a no-op success — no write, no Log line', async () => {
    await writeChainedTicket('T-0001', 'build', ['skip verify']);
    const file = path.join(vaultDir, 'tickets', 'build', 'T-0001.md');
    const before = await fsp.readFile(file, 'utf8');
    const service = serviceOf();

    const outcome = await service.setChain({ id: 'T-0001', chain: ['skip verify'] });

    expect(outcome).toEqual({ ok: true });
    expect(await fsp.readFile(file, 'utf8')).toBe(before);
  });

  it('an unreadable entry refuses with the expected-shape hint and touches nothing', async () => {
    await writeTicket('T-0001', 'build');
    const file = path.join(vaultDir, 'tickets', 'build', 'T-0001.md');
    const before = await fsp.readFile(file, 'utf8');
    const service = serviceOf();

    const outcome = await service.setChain({ id: 'T-0001', chain: ['skip verify please'] });

    expect(outcome).toEqual({
      ok: false,
      error: 'chain entry "skip verify please" is not readable — expected e.g. "insert design after review"',
    });
    expect(await fsp.readFile(file, 'utf8')).toBe(before);
  });

  it('a delta naming a phase outside the pipeline refuses', async () => {
    await writeTicket('T-0001', 'build');
    const file = path.join(vaultDir, 'tickets', 'build', 'T-0001.md');
    const before = await fsp.readFile(file, 'utf8');
    const service = serviceOf();

    const outcome = await service.setChain({ id: 'T-0001', chain: ['skip design'] });

    expect(outcome).toEqual({ ok: false, error: 'the pipeline has no phase "design"' });
    expect(await fsp.readFile(file, 'utf8')).toBe(before);
  });

  it('a skip of a past gate refuses — the delta only reaches future gates', async () => {
    await writeTicket('T-0001', 'build');
    const service = serviceOf();

    const outcome = await service.setChain({ id: 'T-0001', chain: ['skip inbox'] });

    expect(outcome).toEqual({
      ok: false,
      error: 'inbox is the current or a past gate — a skip only reaches future gates',
    });
  });

  it('a phase both skipped and inserted refuses — strike the gate or revisit it, not both', async () => {
    await writeTicket('T-0001', 'build');
    const service = serviceOf();

    const outcome = await service.setChain({ id: 'T-0001', chain: ['insert review after build', 'skip review'] });

    expect(outcome).toEqual({
      ok: false,
      error: 'review is both skipped and inserted — strike the gate or revisit it, not both',
    });
  });

  it('a live run refuses the chain change and leaves the file untouched', async () => {
    await writeTicket('T-0001', 'build');
    const file = path.join(vaultDir, 'tickets', 'build', 'T-0001.md');
    const text = await fsp.readFile(file, 'utf8');
    await fsp.writeFile(
      file,
      text.replace(
        'branch:',
        "run:\n  pid: 42\n  started-at: '2026-11-02T10:00:00Z'\n  stream: run-1\nbranch:",
      ),
      'utf8',
    );
    const service = serviceOf();

    const outcome = await service.setChain({ id: 'T-0001', chain: ['skip verify'] });

    expect(outcome).toEqual({
      ok: false,
      error: 'A run is live on this ticket. Change the chain when the run has ended.',
    });
    const after = await fsp.readFile(file, 'utf8');
    expect(after).not.toContain('chain:');
    expect(after).not.toMatch(/— chain /);
  });

  it('refuses a ticket that is not on the board', async () => {
    const service = serviceOf();

    const outcome = await service.setChain({ id: 'T-0099', chain: ['skip verify'] });

    expect(outcome).toEqual({ ok: false, error: 'T-0099 is not on the board' });
  });
});

// `setBlockedBy` follows the setChain pattern: the pipeline read runs
// through the non-enqueueing `snapshot()` (inside findCard) — the
// single-writer queue is never re-entered from inside an op.
describe('EngineBoardService setBlockedBy (T-0050)', () => {
  it('setting blockers writes the whole list with the blocked-by Log line — the commit degrades to the unversioned warning here', async () => {
    await writeTicket('T-0002', 'build');
    const service = serviceOf();

    const outcome = await service.setBlockedBy({ id: 'T-0002', blockedBy: ['T-0001', 'T-0003'], actor: 'owner@test' });

    expect(outcome).toMatchObject({
      ok: true,
      warning: 'the tickets vault is not a git repository — the change is not versioned',
    });
    const text = await fsp.readFile(path.join(vaultDir, 'tickets', 'build', 'T-0002.md'), 'utf8');
    expect(text).toContain('blocked-by:\n  - T-0001\n  - T-0003');
    expect(text).toMatch(/- '\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z' owner@test — blocked-by 2 ids/);
    // The rest of the file is untouched — description and the creation line stand.
    expect(text).toContain('## Description');
    expect(text).toContain("- '2026-11-02T10:00:00Z' owner@test — created in build");
  });

  it('an empty list removes the blocked-by key with the blocked-by none Log line', async () => {
    await writeTicket('T-0002', 'build');
    const file = path.join(vaultDir, 'tickets', 'build', 'T-0002.md');
    const before = await fsp.readFile(file, 'utf8');
    await fsp.writeFile(file, before.replace('priority: normal\n', 'priority: normal\nblocked-by: [T-0001]\n'), 'utf8');
    const service = serviceOf();

    const outcome = await service.setBlockedBy({ id: 'T-0002', blockedBy: [] });

    expect(outcome.ok).toBe(true);
    const text = await fsp.readFile(file, 'utf8');
    expect(text).not.toContain('blocked-by:');
    expect(text).toMatch(/- '\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z' owner@test — blocked-by none/);
  });

  it('setting the list the file already carries is a no-op success — no write, no Log line', async () => {
    await writeTicket('T-0002', 'build');
    const file = path.join(vaultDir, 'tickets', 'build', 'T-0002.md');
    const before = await fsp.readFile(file, 'utf8');
    await fsp.writeFile(file, before.replace('priority: normal\n', 'priority: normal\nblocked-by: [T-0001, T-0003]\n'), 'utf8');
    const service = serviceOf();

    const outcome = await service.setBlockedBy({ id: 'T-0002', blockedBy: ['T-0001', 'T-0003'] });

    expect(outcome).toEqual({ ok: true });
    const after = await fsp.readFile(file, 'utf8');
    expect(after).toBe(before.replace('priority: normal\n', 'priority: normal\nblocked-by: [T-0001, T-0003]\n'));
    expect(after).not.toMatch(/— blocked-by /);
  });

  it('an id outside the ticket grammar refuses and touches nothing', async () => {
    await writeTicket('T-0002', 'build');
    const file = path.join(vaultDir, 'tickets', 'build', 'T-0002.md');
    const before = await fsp.readFile(file, 'utf8');
    const service = serviceOf();

    const outcome = await service.setBlockedBy({ id: 'T-0002', blockedBy: ['T-1'] });

    expect(outcome).toEqual({ ok: false, error: 'blocked-by: "T-1" is not a ticket id' });
    expect(await fsp.readFile(file, 'utf8')).toBe(before);
  });

  it('a live run refuses the blocker change and leaves the file untouched', async () => {
    await writeTicket('T-0002', 'build');
    const file = path.join(vaultDir, 'tickets', 'build', 'T-0002.md');
    const text = await fsp.readFile(file, 'utf8');
    await fsp.writeFile(
      file,
      text.replace(
        'branch:',
        "run:\n  pid: 42\n  started-at: '2026-11-02T10:00:00Z'\n  stream: run-1\nbranch:",
      ),
      'utf8',
    );
    const service = serviceOf();

    const outcome = await service.setBlockedBy({ id: 'T-0002', blockedBy: ['T-0001'] });

    expect(outcome).toEqual({
      ok: false,
      error: 'A run is live on this ticket. Change the blockers when the run has ended.',
    });
    const after = await fsp.readFile(file, 'utf8');
    expect(after).not.toContain('blocked-by');
    expect(after).not.toMatch(/— blocked-by /);
  });

  it('refuses a ticket that is not on the board', async () => {
    const service = serviceOf();

    const outcome = await service.setBlockedBy({ id: 'T-0099', blockedBy: ['T-0001'] });

    expect(outcome).toEqual({ ok: false, error: 'T-0099 is not on the board' });
  });
});

describe('EngineBoardService configurable priorities (T0)', () => {
  const VOCAB_PIPELINE = `---
priorities: [p0, p1, p2]
phases:
  - { id: inbox, title: Inbox, handover: manual }
  - { id: done, title: Done, handover: none }
---
The pipeline.
`;

  beforeEach(async () => {
    await fsp.writeFile(path.join(vaultDir, 'tickets', '_meta', 'pipeline.md'), VOCAB_PIPELINE, 'utf8');
  });

  it('setPriority accepts a word of the vault vocabulary and writes it', async () => {
    await writeTicket('T-0001', 'inbox');
    const service = serviceOf();

    const outcome = await service.setPriority({ id: 'T-0001', priority: 'p0' });

    expect(outcome).toMatchObject({ ok: true });
    const text = await fsp.readFile(path.join(vaultDir, 'tickets', 'inbox', 'T-0001.md'), 'utf8');
    expect(text).toContain('priority: p0');
  });

  it('setPriority refuses a word outside the vault vocabulary', async () => {
    await writeTicket('T-0001', 'inbox');
    const file = path.join(vaultDir, 'tickets', 'inbox', 'T-0001.md');
    const before = await fsp.readFile(file, 'utf8');
    const service = serviceOf();

    const outcome = await service.setPriority({ id: 'T-0001', priority: 'urgent' });

    expect(outcome).toEqual({ ok: false, error: 'unknown priority "urgent"' });
    expect(await fsp.readFile(file, 'utf8')).toBe(before);
  });

  it('createTicket refuses a priority the vocabulary does not carry', async () => {
    const service = serviceOf();

    const outcome = await service.createTicket({
      title: 'Off-vocabulary',
      description: 'Do the thing.',
      priority: 'high',
      repo: null,
    });

    expect(outcome).toEqual({
      ok: false,
      error: 'unknown priority "high" — this board\'s vocabulary is p0, p1, p2',
    });
  });

  it('createTicket writes a vocabulary priority into the new file', async () => {
    const service = serviceOf();

    const outcome = await service.createTicket({
      title: 'On-vocabulary',
      description: 'Do the thing.',
      priority: 'p0',
      repo: null,
    });

    expect(outcome).toMatchObject({ ok: true, id: 'T-0001' });
    const text = await fsp.readFile(path.join(vaultDir, 'tickets', 'inbox', 'T-0001.md'), 'utf8');
    expect(text).toContain('priority: p0');
  });
});
