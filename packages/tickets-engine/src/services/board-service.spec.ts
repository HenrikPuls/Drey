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
import { parseHandover } from '../contracts/tickets';

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

describe('EngineBoardService.readTicket reaches closed tickets (D-7a)', () => {
  it('reads a done ticket and an archived one, and still refuses an unknown id', async () => {
    await writeTicket('T-0001', 'done');
    await writeTicket('T-0002', 'inbox');
    const service = serviceOf();
    expect((await service.archive({ id: 'T-0002' })).ok).toBe(true);

    expect(await service.readTicket('T-0001')).toMatchObject({ ok: true, card: { id: 'T-0001' } });
    // An archived ticket has no card, but the chat reads its file by id.
    expect(await service.readTicket('T-0002')).toMatchObject({ ok: false });
    expect(await service.readAnyTicket('T-0001')).toMatchObject({ ok: true });
    expect(await service.readAnyTicket('T-0002')).toMatchObject({ ok: true, text: expect.stringContaining('Ticket T-0002') });
    expect(await service.readAnyTicket('T-0999')).toMatchObject({ ok: false });
  });
});

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

  it('an archived ticket still opens, is listed under Show older and counts for Done this week (E13-21)', async () => {
    await writeTicket('T-0001', 'inbox');
    await writeTicket('T-0002', 'inbox');
    const service = serviceOf({ events: { ledger: (write) => ledgerWrites.push(write) } });
    expect((await service.archive({ id: 'T-0001' })).ok).toBe(true);

    const read = await service.readTicket('T-0001');
    expect(read).toMatchObject({ ok: true, card: { id: 'T-0001', phase: 'archive', path: 'tickets/archive/T-0001.md' } });
    expect(read.ok && read.text).toContain('T-0001');
    expect(await service.readTicket('T-0099')).toMatchObject({ ok: false });
    expect(await service.readTicket('../_meta/pipeline')).toMatchObject({ ok: false });

    expect(await service.archivedTickets()).toMatchObject({ ok: true, tickets: [{ id: 'T-0001' }] });
    expect(await service.archivedTickets({ query: 'nothing like this' })).toEqual({ ok: true, tickets: [] });
    expect((await service.snapshot()).recentDone.map((d) => d.id)).toEqual(['T-0001']);
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

describe('EngineBoardService snapshot usage — the ledger settled sums (costtracking)', () => {
  it('snapshot attaches the run_settled sums of each ticket from tickets/_meta/ledger.jsonl', async () => {
    await writeTicket('T-0001', 'inbox');
    await writeTicket('T-0002', 'inbox');
    await fsp.writeFile(
      path.join(vaultDir, 'tickets', '_meta', 'ledger.jsonl'),
      [
        '{"v":1,"ts":"2026-11-02T09:00:00Z","event":"dispatched","ticket":"T-0001","persona":"pia","model":"opus"}',
        '{"v":1,"ts":"2026-11-02T09:41:00Z","event":"run_settled","ticket":"T-0001","persona":"pia","model":"opus","tokensIn":48000,"tokensOut":6000,"cost":1.17}',
        '{"v":1,"ts":"2026-11-02T10:05:00Z","event":"run_settled","ticket":"T-0001","persona":"ben","model":"glm-5.3","tokensIn":50000,"tokensOut":2500}',
        '{"v":1,"ts":"2026-11-02T10:06:00Z","event":"phase","ticket":"T-0001","from":"inbox","to":"done"}',
        '{"v":1,"ts":"broken line"}',
      ].join('\n'),
      'utf8',
    );
    const service = serviceOf();

    const snap = await service.snapshot();

    const card = snap.columns[0]!.tickets.find((t) => t.id === 'T-0001')!;
    expect(card.usage).toEqual({ tokensIn: 98_000, tokensOut: 8_500, cost: 1.17, runs: 2 });
    const untracked = snap.columns[0]!.tickets.find((t) => t.id === 'T-0002')!;
    expect(untracked.usage).toBeUndefined();
  });

  it('snapshot without a ledger attaches no usage at all', async () => {
    await writeTicket('T-0001', 'inbox');
    const service = serviceOf();
    const snap = await service.snapshot();
    expect(snap.columns[0]!.tickets[0]!.usage).toBeUndefined();
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

describe('persona thread, memory pin and patch (U4, concept §4.4/§4.5)', () => {
  const PERSONA_DIR = ['tickets', '_meta', 'personas', 'pia'];

  async function writePia(): Promise<void> {
    await fsp.mkdir(path.join(vaultDir, ...PERSONA_DIR), { recursive: true });
    await fsp.writeFile(
      path.join(vaultDir, ...PERSONA_DIR, 'persona.md'),
      "---\ntitle: Pia\nrole: builder\nworker: claude-code\nmodels:\n  default: opus\n  pool: [opus]\n  router: off\ncolor: '#a78bfa'\nskills: []\n---\n\nPia plans carefully.\n",
      'utf8',
    );
  }

  it('personaThreadAppend creates the thread chat-session style and appends one line per message', async () => {
    await writePia();
    const service = serviceOf();

    const first = await service.personaThreadAppend({ id: 'pia', text: 'Treat rank fields as the word of the owner' });
    if (!first.ok) {
      throw new Error(first.error);
    }
    const file = await fsp.readFile(path.join(vaultDir, ...PERSONA_DIR, 'thread.md'), 'utf8');
    expect(file).toContain('title: "Pia"');
    expect(file).toMatch(/- '\d{4}-\d{2}-\d{2}T.*' owner — Treat rank fields as the word of the owner\n$/);
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]).toMatchObject({ role: 'owner', text: 'Treat rank fields as the word of the owner' });

    const second = await service.personaThreadAppend({ id: 'pia', text: 'second line' });
    if (!second.ok) {
      throw new Error(second.error);
    }
    expect(second.messages).toHaveLength(2);

    // a multi-line message flattens to one line
    await service.personaThreadAppend({ id: 'pia', text: 'a\nb' });
    const file2 = await fsp.readFile(path.join(vaultDir, ...PERSONA_DIR, 'thread.md'), 'utf8');
    expect(file2).toContain('owner — a b\n');
  });

  it('personaThread reads the messages back and a thread-less persona reads as none', async () => {
    await writePia();
    const service = serviceOf();
    expect(await service.personaThread('pia')).toEqual({ ok: true, messages: [] });
    await service.personaThreadAppend({ id: 'pia', text: 'hello' });
    const read = await service.personaThread('pia');
    expect(read.ok && read.messages).toHaveLength(1);
  });

  it('personaMemoryAppend appends through the persona store and personaMemory reads entries with pins', async () => {
    await writePia();
    const service = serviceOf();

    const appended = await service.personaMemoryAppend({ id: 'pia', text: 'gate red on lint means fix lint first' });
    if (!appended.ok) {
      throw new Error(appended.error);
    }
    expect(appended.entries).toEqual([{ text: 'gate red on lint means fix lint first', pinned: false }]);
    const file = await fsp.readFile(path.join(vaultDir, ...PERSONA_DIR, 'memory.md'), 'utf8');
    expect(file).toBe('# Memory\n\ngate red on lint means fix lint first\n');

    const pinned = await service.personaMemoryPin({ id: 'pia', index: 0, pinned: true });
    if (!pinned.ok) {
      throw new Error(pinned.error);
    }
    expect(pinned.entries).toEqual([{ text: 'gate red on lint means fix lint first', pinned: true }]);
    expect(await fsp.readFile(path.join(vaultDir, ...PERSONA_DIR, 'memory.md'), 'utf8')).toBe(
      '# Memory\n\n- gate red on lint means fix lint first [pinned]\n',
    );
    const unpinned = await service.personaMemoryPin({ id: 'pia', index: 0, pinned: false });
    if (!unpinned.ok) {
      throw new Error(unpinned.error);
    }
    expect(unpinned.entries).toEqual([{ text: 'gate red on lint means fix lint first', pinned: false }]);
    expect(await service.personaMemory('pia')).toMatchObject({ ok: true, entries: [{ text: 'gate red on lint means fix lint first', pinned: false }] });
  });

  it('the pin toggle refuses out-of-range indexes and memory-less personas with a readable error', async () => {
    await writePia();
    const service = serviceOf();
    expect(await service.personaMemoryPin({ id: 'pia', index: 0, pinned: true })).toEqual({
      ok: false,
      error: 'persona "pia" has no memory entries yet',
    });
    await service.personaMemoryAppend({ id: 'pia', text: 'one' });
    expect(await service.personaMemoryPin({ id: 'pia', index: 3, pinned: true })).toEqual({
      ok: false,
      error: 'no memory entry at index 3',
    });
    expect(await service.personaMemoryPin({ id: 'pia', index: -1, pinned: true })).toMatchObject({ ok: false });
  });

  it('every persona-scoped method refuses an unknown persona id', async () => {
    const service = serviceOf();
    const missing = { ok: false, error: 'persona "ghost" does not exist — create tickets/_meta/personas/ghost/persona.md first' };
    expect(await service.personaThread('ghost')).toEqual(missing);
    expect(await service.personaThreadAppend({ id: 'ghost', text: 'x' })).toEqual(missing);
    expect(await service.personaMemory('ghost')).toEqual(missing);
    expect(await service.personaMemoryAppend({ id: 'ghost', text: 'x' })).toEqual(missing);
    expect(await service.personaMemoryPin({ id: 'ghost', index: 0, pinned: true })).toEqual(missing);
    expect(await service.personaPatch({ id: 'ghost', title: 'X' })).toEqual(missing);
  });

  it('personaPatch writes only the sent keys over personaFileText and keeps the prose', async () => {
    await writePia();
    const service = serviceOf();

    const outcome = await service.personaPatch({
      id: 'pia',
      model: 'sonnet',
      pool: ['sonnet', 'haiku'],
      router: 'budget',
      color: '#ff8800',
      skills: ['diff-review'],
      prompt: 'You are Pia, the careful planner.\n',
    });
    expect(outcome.ok).toBe(true);
    const personaMd = await fsp.readFile(path.join(vaultDir, ...PERSONA_DIR, 'persona.md'), 'utf8');
    expect(personaMd).toContain('default: sonnet');
    expect(personaMd).toContain('pool: [sonnet, haiku]');
    expect(personaMd).toContain('router: budget');
    expect(personaMd).toContain("color: '#ff8800'");
    expect(personaMd).toContain('skills: [diff-review]');
    expect(personaMd).toContain('role: builder'); // not sent — untouched
    expect(personaMd).toContain('worker: claude-code'); // not sent — untouched
    expect(personaMd).toContain('Pia plans carefully.'); // the owner's prose survives
    expect(personaMd).not.toContain('Who Pia is: role, tone, limits');
    const promptMd = await fsp.readFile(path.join(vaultDir, ...PERSONA_DIR, 'prompt.md'), 'utf8');
    expect(promptMd).toBe('You are Pia, the careful planner.\n');
    // the rewritten file parses back to the same persona plus the changes
    const parsed = await service.listPersonas();
    const pia = parsed.find((p) => p.id === 'pia');
    expect(pia?.models).toEqual({ default: 'sonnet', pool: ['sonnet', 'haiku'], router: 'budget' });
    expect(pia?.skills).toEqual(['diff-review']);
  });

  it('personaPatch validates the listed rules and changes nothing on a refusal', async () => {
    await writePia();
    const service = serviceOf();
    const before = await fsp.readFile(path.join(vaultDir, ...PERSONA_DIR, 'persona.md'), 'utf8');

    expect(await service.personaPatch({ id: 'pia', router: 'chaos' })).toEqual({ ok: false, error: 'the router is "off", "budget" or "escalate-on-fail"' });
    expect(await service.personaPatch({ id: 'pia', color: 'red' })).toEqual({ ok: false, error: 'the color is a #rrggbb hex value' });
    expect(await service.personaPatch({ id: 'pia', pool: [] })).toEqual({ ok: false, error: 'the model pool is a non-empty list of model names' });
    expect(await service.personaPatch({ id: 'pia', title: '  ' })).toEqual({ ok: false, error: 'the title is not empty' });
    expect(await service.personaPatch({ id: 'pia', role: 'wizard' })).toMatchObject({ ok: false });
    expect(await fsp.readFile(path.join(vaultDir, ...PERSONA_DIR, 'persona.md'), 'utf8')).toBe(before);
  });

  it('personaPatch treats a patch without any writable key as a no-op and a multi-key patch as one commit shape', async () => {
    await writePia();
    const service = serviceOf();
    expect(await service.personaPatch({ id: 'pia' })).toEqual({ ok: true });
    const outcome = await service.personaPatch({ id: 'pia', title: 'Pia P.', model: 'gpt-5' });
    expect(outcome.ok).toBe(true);
    const personaMd = await fsp.readFile(path.join(vaultDir, ...PERSONA_DIR, 'persona.md'), 'utf8');
    expect(personaMd).toContain('title: Pia P.');
    expect(personaMd).toContain('default: gpt-5');
  });
});

describe('EngineBoardService sendBack with review comments (E11-3)', () => {
  const REVIEW_PIPELINE = `---
phases:
  - { id: inbox, title: Inbox, handover: manual }
  - { id: build, title: Build, handover: agent build-default }
  - { id: ready, title: Ready, handover: manual }
---
The pipeline.
`;

  it('moves the ticket back and writes the comments into its Handover', async () => {
    await fsp.writeFile(path.join(vaultDir, 'tickets', '_meta', 'pipeline.md'), REVIEW_PIPELINE, 'utf8');
    await writeTicket('T-0001', 'ready');
    const service = serviceOf();

    const outcome = await service.sendBack({
      id: 'T-0001',
      note: '2 review comments',
      comments: [
        { file: 'src/a.ts', line: 27, endLine: null, text: 'Why here?' },
        { file: 'src/a.ts', line: 30, endLine: 33, text: 'Rename.' },
      ],
    });

    expect(outcome.ok).toBe(true);
    const text = await fsp.readFile(path.join(vaultDir, 'tickets', '20-build', 'T-0001.md'), 'utf8');
    expect(text).toContain('## Handover');
    expect(text).toContain('### Review feedback');
    expect(text).toContain('- `src/a.ts:27` — Why here?');
    expect(text).toContain('- `src/a.ts:30-33` — Rename.');
    expect(text).toContain('sent back: 2 review comments');
    await expect(fsp.access(path.join(vaultDir, 'tickets', 'ready', 'T-0001.md'))).rejects.toBeDefined();
  });

  it('leaves the ticket text alone when no comments ride along', async () => {
    await fsp.writeFile(path.join(vaultDir, 'tickets', '_meta', 'pipeline.md'), REVIEW_PIPELINE, 'utf8');
    await writeTicket('T-0001', 'ready');
    const outcome = await serviceOf().sendBack({ id: 'T-0001', note: 'Fix the colour' });
    expect(outcome.ok).toBe(true);
    const text = await fsp.readFile(path.join(vaultDir, 'tickets', '20-build', 'T-0001.md'), 'utf8');
    expect(text).not.toContain('Review feedback');
  });
});

describe('EngineBoardService estimateOf (E11-4)', () => {
  const entry = (cost: number, phase = 'build'): string =>
    `- { phase: ${phase}, persona: ben, model: sonnet, tokens: 40k, cost: ${cost}, dauer: 8m, ausgang: handed-over }`;

  async function withHistory(id: string, folder: string, lines: readonly string[]): Promise<void> {
    await writeTicket(id, 'inbox');
    const from = path.join(vaultDir, 'tickets', 'inbox', `${id}.md`);
    const text = await fsp.readFile(from, 'utf8');
    const to = path.join(vaultDir, 'tickets', folder, `${id}.md`);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.writeFile(to, [text.trimEnd(), '', '## Verlauf', '', ...lines, ''].join(String.fromCharCode(10)), 'utf8');
    await fsp.rm(from);
  }

  it('reads the history of every ticket, the archive included, and needs three similar runs', async () => {
    const key = { gate: 'build', persona: 'ben', model: 'sonnet' };
    const service = serviceOf();
    await withHistory('T-0001', 'done', [entry(0.2)]);
    await withHistory('T-0002', 'archive', [entry(0.4), entry(0.9, 'review')]);
    expect(await service.estimateOf(key)).toBeNull();

    await withHistory('T-0003', 'done', [entry(0.3)]);
    expect(await service.estimateOf(key)).toEqual({ ...key, runs: 3, cost: 0.3, minutes: 8, tokens: 40_000 });
    expect(await service.estimateOf({ ...key, gate: 'review' })).toBeNull();
  });
});

// E10-3: the shape turn's two board seams — the plan chapter write and the
// read-only look into the ticket's repository.
describe('EngineBoardService shape seams (E10-3)', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shape-repo-'));
    await fsp.mkdir(path.join(repoDir, 'src'), { recursive: true });
    await fsp.mkdir(path.join(repoDir, '.git'), { recursive: true });
    await fsp.writeFile(path.join(repoDir, 'CLAUDE.md'), 'rules', 'utf8');
    await fsp.writeFile(path.join(repoDir, 'src', 'a.ts'), 'export const a = 1;', 'utf8');
    await fsp.writeFile(path.join(repoDir, '.env'), 'SECRET=1', 'utf8');
    await fsp.writeFile(path.join(repoDir, '.git', 'config'), 'x', 'utf8');
    await fsp.writeFile(path.join(repoDir, 'logo.bin'), Buffer.from([1, 0, 2]));
    await fsp.writeFile(
      path.join(vaultDir, 'tickets', '_meta', 'repos.md'),
      `---\nrepos:\n  demo:\n    url: https://example.com/demo.git\n    path: '${repoDir.replace(/\\/g, '/')}'\n---\n`,
      'utf8',
    );
  });

  afterEach(async () => {
    await fsp.rm(repoDir, { recursive: true, force: true });
  });

  async function writeRepoTicket(id: string, phase: string): Promise<string> {
    await writeTicket(id, phase);
    const file = path.join(vaultDir, 'tickets', phase, `${id}.md`);
    const text = await fsp.readFile(file, 'utf8');
    await fsp.writeFile(file, text.replace(/^repo:.*$/m, 'repo: demo'), 'utf8');
    return file;
  }

  it('setPlan replaces only the Plan chapter and keeps the rest of the file', async () => {
    await writeTicket('T-0001', 'inbox');
    const file = path.join(vaultDir, 'tickets', 'inbox', 'T-0001.md');
    const service = serviceOf();

    expect((await service.setPlan({ id: 'T-0001', plan: '### Goal\n\nOne thing.' })).ok).toBe(true);
    const text = await fsp.readFile(file, 'utf8');
    expect(text).toContain('## Plan\n\n### Goal\n\nOne thing.');
    expect(text).toContain('Do the thing.');
    expect(text).toContain('created in inbox');

    // The same plan again is a no-op success.
    const before = await fsp.readFile(file, 'utf8');
    expect(await service.setPlan({ id: 'T-0001', plan: '### Goal\n\nOne thing.' })).toEqual({ ok: true });
    expect(await fsp.readFile(file, 'utf8')).toBe(before);
  });

  it('setPlan refuses an unknown ticket', async () => {
    expect(await serviceOf().setPlan({ id: 'T-0999', plan: 'x' })).toEqual({ ok: false, error: 'T-0999 is not on the board' });
  });

  it('reads a file and lists a directory of the ticket’s repository', async () => {
    await writeRepoTicket('T-0001', 'inbox');
    const service = serviceOf();

    expect(await service.readRepoFile('T-0001', 'src/a.ts')).toEqual({ ok: true, text: 'export const a = 1;' });
    const listing = await service.readRepoFile('T-0001', '');
    expect(listing).toMatchObject({ ok: true });
    expect((listing as { text: string }).text.split('\n')).toEqual(['CLAUDE.md', 'logo.bin', 'src/']);
    expect(await service.readRepoFile('T-0001', 'src/')).toEqual({ ok: true, text: 'a.ts' });
  });

  it('keeps git internals, secrets, escapes and binaries shut', async () => {
    await writeRepoTicket('T-0001', 'inbox');
    const service = serviceOf();

    for (const bad of ['.git/config', '.env', '../outside.txt', '/etc/passwd', 'src//a.ts']) {
      expect((await service.readRepoFile('T-0001', bad)).ok, bad).toBe(false);
    }
    expect(await service.readRepoFile('T-0001', 'logo.bin')).toEqual({ ok: false, error: '"logo.bin" is a binary file' });
    expect(await service.readRepoFile('T-0001', 'missing.ts')).toEqual({ ok: false, error: '"missing.ts" does not exist' });
  });

  it('refuses without a repository', async () => {
    await writeTicket('T-0001', 'inbox');
    expect((await serviceOf().readRepoFile('T-0001', 'CLAUDE.md')).ok).toBe(false);
  });
});

describe('EngineBoardService default pipeline (E12-9c)', () => {
  const pipelinePath = (): string => path.join(vaultDir, 'tickets', '_meta', 'pipeline.md');

  it('seeds Inbox · Plan · Build · Review · Sign Off · Done on a new board', async () => {
    await fsp.rm(pipelinePath());
    expect(await serviceOf().initialize('v')).toMatchObject({ ok: true });

    const snap = await serviceOf().snapshot();
    expect(snap.pipeline.map((p) => [p.id, p.title])).toEqual([
      ['inbox', 'Inbox'],
      ['plan', 'Plan'],
      ['build', 'Build'],
      ['review', 'Review'],
      ['sign-off', 'Sign Off'],
      ['done', 'Done'],
    ]);
    expect(snap.pipeline.map((p) => parseHandover(p.handover).mode)).toEqual(['manual', 'agent', 'agent', 'manual', 'manual', 'none']);
    expect(snap.pipeline.filter((p) => p.claim).map((p) => p.id)).toEqual(['plan', 'build']);
    // The columns the human persona works carry its pin; the agent columns carry none (the ladder decides).
    expect(snap.pipeline.map((p) => [p.id, p.persona])).toEqual([
      ['inbox', 'you'],
      ['plan', null],
      ['build', null],
      ['review', 'you'],
      ['sign-off', 'you'],
      ['done', null],
    ]);
    // ...and the persona they name exists from the first minute, titled You.
    const personaFile = await fsp.readFile(path.join(vaultDir, 'tickets', '_meta', 'personas', 'you', 'persona.md'), 'utf8');
    expect(personaFile).toContain('kind: human');
    expect(personaFile).toMatch(/title: ['"]?You['"]?\s/);
    // Review and Sign Off are both the owner's checkpoints; Inbox (before the first agent column) is a plain queue.
    expect([...snap.checkpoints]).toEqual(['review', 'sign-off', 'done']);
  });

  it('renames the human persona: one title on the persona file, blank goes back to You', async () => {
    await fsp.rm(pipelinePath());
    expect(await serviceOf().initialize('v')).toMatchObject({ ok: true });
    const file = path.join(vaultDir, 'tickets', '_meta', 'personas', 'you', 'persona.md');

    expect(await serviceOf().setHumanName('  Henrik ')).toMatchObject({ ok: true });
    expect(await fsp.readFile(file, 'utf8')).toMatch(/title: ['"]?Henrik['"]?\s/);
    const named = await serviceOf().listPersonas();
    expect(named.filter((p) => p.kind === 'human').map((p) => [p.id, p.title])).toEqual([['you', 'Henrik']]);

    expect(await serviceOf().setHumanName('')).toMatchObject({ ok: true });
    expect((await serviceOf().listPersonas()).find((p) => p.kind === 'human')?.title).toBe('You');
  });

  it('an existing board gets the human persona created on first sight and keeps its columns', async () => {
    // The shared board of this suite predates the pins: its columns carry none.
    const snap = await serviceOf().snapshot();
    expect(snap.pipeline.every((p) => p.persona === null)).toBe(true);
    await serviceOf().ensureHumanPersona();
    expect((await serviceOf().listPersonas()).some((p) => p.kind === 'human' && p.title === 'You')).toBe(true);
    expect((await serviceOf().snapshot()).pipeline.every((p) => p.persona === null)).toBe(true);
  });

  it('leaves a board with the old default pipeline exactly as it is', async () => {
    const oldDefault = [
      '---',
      'phases:',
      '  - { id: inbox, title: Inbox, handover: manual }',
      '  - { id: prioritized, title: Prioritized, handover: manual }',
      '  - { id: build, title: Build, wip: 3, claim: true, handover: agent build-default }',
      '  - { id: commit, title: Commit, handover: agent commit-default }',
      '  - { id: done, title: Done, handover: none }',
      '---',
      'Mine.',
      '',
    ].join('\n');
    await fsp.writeFile(pipelinePath(), oldDefault);
    expect(await serviceOf().initialize('v')).toMatchObject({ ok: false });
    expect(await fsp.readFile(pipelinePath(), 'utf8')).toBe(oldDefault);

    const snap = await serviceOf().snapshot();
    expect(snap.pipeline.map((p) => [p.id, p.title])).toEqual([
      ['inbox', 'Inbox'],
      ['prioritized', 'Prioritized'],
      ['build', 'Build'],
      ['commit', 'Commit'],
      ['done', 'Done'],
    ]);
    expect([...snap.checkpoints]).toEqual(['done']);
  });

  it('never renames what a board already has: an existing Inbox title stays', async () => {
    const before = await fsp.readFile(pipelinePath(), 'utf8');
    expect(await serviceOf().initialize('v')).toMatchObject({ ok: false });
    expect(await fsp.readFile(pipelinePath(), 'utf8')).toBe(before);

    const snap = await serviceOf().snapshot();
    expect(snap.pipeline.map((p) => p.title)).toEqual(['Inbox', 'Done']);
  });
});
