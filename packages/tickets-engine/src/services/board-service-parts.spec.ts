import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EngineBoardService } from './board-service';
import type { EngineHost, EngineVault, FleetPort } from './host';
import { TicketsGit } from '../core/tickets-git';
import { newTicketFileText, patchTicketFile } from '../core/ticket-files';
import { normalizeFleetCaps, normalizeFleetHandover, normalizeFleetPools } from '../fleet/protocol';

/**
 * E10-4: the plan to approve against a real temp vault — the cards of a
 * ticket's `### Parts` (persona, flow, state, lock, start rule), the
 * list edits (persona pick, move, delete) with the locks, and the
 * release that mints one ticket per part with `parent:`, `persona:`,
 * `chain:` and `blocked-by:` in one commit's worth of files.
 */

const PIPELINE = `---
phases:
  - { id: inbox, title: Inbox, handover: manual }
  - { id: build, title: Build, handover: manual, persona: ben }
  - { id: commit, title: Commit, handover: manual }
  - { id: done, title: Done, handover: none }
---
The pipeline.
`;

const PARENT_PLAN = `
## Plan

Goal text.

### Parts

- [ ] Capture window
  persona: ben
  reason: small and isolated
- [ ] Dictation hand-off
  chain: skip commit; notify build
- [ ] Tidy-up
  persona: paul
`;

let vaultDir = '';
let vault: EngineVault;

beforeEach(async () => {
  vaultDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-parts-'));
  vault = { id: 'v', name: 'vault', path: vaultDir, exists: true, active: true };
  await fsp.mkdir(path.join(vaultDir, 'tickets', '_meta'), { recursive: true });
  await fsp.writeFile(path.join(vaultDir, 'tickets', '_meta', 'pipeline.md'), PIPELINE, 'utf8');
  for (const [id, title, model] of [
    ['ben', 'Ben', 'sonnet'],
    ['paul', 'Paul', 'opus'],
    ['ralf', 'Ralf', 'opus'],
  ] as const) {
    await fsp.mkdir(path.join(vaultDir, 'tickets', '_meta', 'personas', id), { recursive: true });
    await fsp.writeFile(
      path.join(vaultDir, 'tickets', '_meta', 'personas', id, 'persona.md'),
      `---\ntitle: ${title}\nrole: builder\nworker: opencode\nmodels:\n  default: ${model}\n  pool: [${model}]\n  router: off\ncolor: '#a78bfa'\n---\n\nWho.\n`,
      'utf8',
    );
  }
});

afterEach(async () => {
  await fsp.rm(vaultDir, { recursive: true, force: true });
});

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
  const write = async (_v: string, p: string, text: string): Promise<void> => {
    await fsp.mkdir(path.dirname(abs(p)), { recursive: true });
    await fsp.writeFile(abs(p), text, 'utf8');
  };
  return {
    listVaults: async () => [vault],
    read: async (_v, p) => fsp.readFile(abs(p), 'utf8'),
    writeAnnounced: write,
    write,
    listMarkdownFiles: async () => listMarkdownFiles(vaultDir),
    resolveAssetPath: (_v, p) => abs(p),
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

function serviceOf(): EngineBoardService {
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
    {},
  );
}

async function writeParent(plan = PARENT_PLAN, phase = 'inbox'): Promise<void> {
  const base = newTicketFileText({
    id: 'T-0130',
    title: 'Voice capture for tickets',
    repo: 'drey',
    priority: 'high',
    rank: 5000,
    firstPhase: phase,
    now: new Date('2026-11-02T10:00:00Z'),
    actor: 'owner@test',
    description: 'Capture by voice.',
  });
  const text = base.replace(/\n## Plan\n[\s\S]*?\n## Log/, `${plan}\n## Log`);
  await fsp.mkdir(path.join(vaultDir, 'tickets', phase), { recursive: true });
  await fsp.writeFile(path.join(vaultDir, 'tickets', phase, 'T-0130.md'), text, 'utf8');
}

const read = (rel: string): Promise<string> => fsp.readFile(path.join(vaultDir, ...rel.split('/')), 'utf8');

/** A released ticket's file: the build directory carries the pipeline's numbering. */
async function fileOf(id: string): Promise<string> {
  const found = (await listMarkdownFiles(vaultDir)).find((f) => f.endsWith(`/${id}.md`));
  if (found === undefined) {
    throw new Error(`${id} has no file`);
  }
  return found;
}

describe('planParts', () => {
  it('answers one card per part with persona, flow, start rule and the picker', async () => {
    await writeParent();
    const reply = await serviceOf().planParts('T-0130');
    expect(reply.ok).toBe(true);
    if (!reply.ok) {
      return;
    }
    expect(reply.gate).toBe('build');
    expect(reply.defaultPersona).toBe('ben');
    expect(reply.parts.map((p) => [p.title, p.persona, p.state, p.locked, p.start])).toEqual([
      ['Capture window', 'ben', 'new', false, 'Runs now'],
      ['Dictation hand-off', null, 'new', false, 'After part 1'],
      ['Tidy-up', 'paul', 'new', false, 'After part 2'],
    ]);
    // The flow starts at the build gate and ends before the terminal phase.
    expect(reply.parts[0]!.flow.map((s) => `${s.title}:${s.persona}`)).toEqual(['Build:ben', 'Commit:null']);
    expect(reply.parts[1]!.flow.map((s) => [s.title, s.skipped, s.notify])).toEqual([
      ['Build', false, true],
      ['Commit', true, false],
    ]);
    expect(reply.personas.map((p) => [p.id, p.model])).toEqual([
      ['ben', 'sonnet'],
      ['paul', 'opus'],
      ['ralf', 'opus'],
    ]);
  });

  it('refuses a ticket that is not on the board', async () => {
    expect(await serviceOf().planParts('T-0999')).toEqual({ ok: false, error: 'T-0999 is not on the board' });
  });
});

describe('editPlanParts', () => {
  it('picks a persona, moves and deletes — written into the plan', async () => {
    await writeParent();
    const board = serviceOf();
    expect((await board.editPlanParts({ id: 'T-0130', edit: { op: 'persona', index: 1, persona: 'ralf' } })).ok).toBe(true);
    expect((await board.editPlanParts({ id: 'T-0130', edit: { op: 'move', from: 2, to: 0 } })).ok).toBe(true);
    let text = await read('tickets/inbox/T-0130.md');
    expect(text.indexOf('Tidy-up')).toBeLessThan(text.indexOf('Capture window'));
    expect(text).toContain('persona: ralf');
    expect((await board.editPlanParts({ id: 'T-0130', edit: { op: 'delete', index: 0 } })).ok).toBe(true);
    text = await read('tickets/inbox/T-0130.md');
    expect(text).not.toContain('Tidy-up');
    expect(text).toContain('Goal text.');
  });

  it('clears a persona pin and refuses an unknown persona', async () => {
    await writeParent();
    const board = serviceOf();
    expect((await board.editPlanParts({ id: 'T-0130', edit: { op: 'persona', index: 0, persona: null } })).ok).toBe(true);
    expect(await read('tickets/inbox/T-0130.md')).not.toMatch(/Capture window\n {2}persona: ben/);
    const refused = await board.editPlanParts({ id: 'T-0130', edit: { op: 'persona', index: 0, persona: 'nobody' } });
    expect(refused.ok).toBe(false);
  });

  it('never drops below two parts', async () => {
    await writeParent(`\n## Plan\n\n### Parts\n\n- [ ] One\n- [ ] Two\n`);
    const refused = await serviceOf().editPlanParts({ id: 'T-0130', edit: { op: 'delete', index: 1 } });
    expect(refused).toEqual({ ok: false, error: 'A split needs two parts. Keep the plan as one ticket instead.' });
  });

  it('refuses positions that do not exist and a ticket without parts', async () => {
    await writeParent();
    const board = serviceOf();
    expect((await board.editPlanParts({ id: 'T-0130', edit: { op: 'move', from: 0, to: 9 } })).ok).toBe(false);
    await writeParent(`\n## Plan\n\nNo parts here.\n`);
    expect(await board.editPlanParts({ id: 'T-0130', edit: { op: 'delete', index: 0 } })).toEqual({ ok: false, error: 'This plan has no parts to change.' });
  });
});

describe('releasePlan', () => {
  it('mints one ticket per part in the build queue, each waiting on the one before', async () => {
    await writeParent();
    const board = serviceOf();
    const reply = await board.releasePlan({ id: 'T-0130', scope: 'all' });
    expect(reply.ok).toBe(true);
    if (!reply.ok) {
      return;
    }
    expect(reply.tickets).toEqual(['T-0131', 'T-0132', 'T-0133']);
    const first = await read(await fileOf('T-0131'));
    const second = await read(await fileOf('T-0132'));
    const third = await read(await fileOf('T-0133'));
    expect(first).toContain('parent: T-0130');
    expect(first).toContain('persona: ben');
    expect(first).not.toContain('blocked-by');
    expect(second).toMatch(/blocked-by:\n  - T-0131\n/);
    expect(second).toContain('skip commit');
    expect(second).toContain('notify build');
    expect(third).toMatch(/blocked-by:\n  - T-0132\n/);
    expect(first).toContain('priority: high');
    expect(first).toContain('repo: drey');
    expect(await read('tickets/inbox/T-0130.md')).toContain('plan released: T-0131, T-0132, T-0133');
    // The board reads them: part 2 and 3 are blocked, part 1 is not.
    const snap = await board.snapshot();
    const cards = snap.columns.flatMap((c) => c.tickets);
    expect(cards.find((c) => c.id === 'T-0131')!.blocked).toEqual([]);
    expect(cards.find((c) => c.id === 'T-0132')!.blocked).toEqual(['T-0131']);
  });

  it('after a release the cards are locked, with the ticket and its state', async () => {
    await writeParent();
    const board = serviceOf();
    await board.releasePlan({ id: 'T-0130', scope: 'all' });
    const reply = await board.planParts('T-0130');
    if (!reply.ok) {
      throw new Error(reply.error);
    }
    expect(reply.parts.map((p) => [p.ticket, p.state, p.locked, p.start])).toEqual([
      ['T-0131', 'queued', true, 'Released as T-0131'],
      ['T-0132', 'queued', true, 'Released as T-0132'],
      ['T-0133', 'queued', true, 'Released as T-0133'],
    ]);
    const refused = await board.editPlanParts({ id: 'T-0130', edit: { op: 'delete', index: 0 } });
    expect(refused.ok).toBe(false);
    expect((await board.releasePlan({ id: 'T-0130', scope: 'all' })).ok).toBe(false);
  });

  it('"first" mints only part 1; a later release adds the rest behind it', async () => {
    await writeParent();
    const board = serviceOf();
    expect(await board.releasePlan({ id: 'T-0130', scope: 'first' })).toMatchObject({ ok: true, tickets: ['T-0131'] });
    // Nothing may move above the released part.
    expect((await board.editPlanParts({ id: 'T-0130', edit: { op: 'move', from: 1, to: 0 } })).ok).toBe(false);
    expect(await board.releasePlan({ id: 'T-0130', scope: 'all' })).toMatchObject({ ok: true, tickets: ['T-0132', 'T-0133'] });
    expect(await read(await fileOf('T-0132'))).toMatch(/blocked-by:\n  - T-0131\n/);
  });

  it('a part whose ticket has a live run is running and locked', async () => {
    await writeParent();
    const board = serviceOf();
    await board.releasePlan({ id: 'T-0130', scope: 'first' });
    const file = await fileOf('T-0131');
    const running = patchTicketFile(await read(file), {
      to: 'build',
      from: null,
      now: new Date('2026-11-04T10:00:00Z'),
      actor: 'agent@x',
      run: { pid: 1, 'started-at': '2026-11-04T10:00:00Z', stream: 'r1' },
    });
    await fsp.writeFile(path.join(vaultDir, ...file.split('/')), running, 'utf8');
    const reply = await board.planParts('T-0130');
    if (!reply.ok) {
      throw new Error(reply.error);
    }
    expect(reply.parts[0]!.state).toBe('running');
    expect(reply.parts[0]!.locked).toBe(true);
    expect(reply.parts[1]!.locked).toBe(false);
  });

  it('refuses a plan without parts, an unknown persona and a chain outside the pipeline', async () => {
    const board = serviceOf();
    await writeParent(`\n## Plan\n\nNo parts.\n`);
    expect(await board.releasePlan({ id: 'T-0130', scope: 'all' })).toEqual({ ok: false, error: 'This plan has no parts to release.' });
    await writeParent(`\n## Plan\n\n### Parts\n\n- [ ] A\n  persona: ben\n- [ ] B\n  persona: ghost\n`);
    const unknown = await board.releasePlan({ id: 'T-0130', scope: 'all' });
    expect(unknown.ok).toBe(false);
    await writeParent(`\n## Plan\n\n### Parts\n\n- [ ] A\n- [ ] B\n  chain: skip nowhere\n`);
    const badChain = await board.releasePlan({ id: 'T-0130', scope: 'all' });
    expect(badChain.ok).toBe(false);
    // Nothing was written by either refusal.
    expect((await listMarkdownFiles(vaultDir)).filter((f) => /T-013[1-9]\.md$/.test(f))).toEqual([]);
  });
});
