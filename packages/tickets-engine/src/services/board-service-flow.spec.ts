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
 * E10-5: the flow editor against a real temp vault -- a ticket's chain and
 * one plan part's chain: the view with personas and models, the pure
 * edits, and the save (ticket header / the part's line in the parent's
 * `### Parts`).
 */

const PIPELINE = `---
phases:
  - { id: inbox, title: Inbox, handover: manual }
  - { id: build, title: Build, handover: manual, persona: ben }
  - { id: review, title: Review, handover: manual, persona: ralf }
  - { id: verify, title: Verify, handover: manual }
  - { id: security, title: Security, handover: manual }
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
  chain: skip verify; notify build
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


describe('flowOf / flowEdit (ticket scope)', () => {
  it('shows the gates from the current one on, with persona, model and owner marks, the terminal phase left out', async () => {
    await writeParent(PARENT_PLAN, 'build');
    const reply = await serviceOf().flowOf({ id: 'T-0130', part: null });
    expect(reply.ok).toBe(true);
    if (!reply.ok) {
      return;
    }
    expect(reply.scope).toEqual({ kind: 'ticket' });
    expect(reply.steps.map((s) => [s.phase, s.state, s.persona, s.model, s.owner, s.locked])).toEqual([
      ['build', 'current', 'ben', 'sonnet', false, true],
      ['review', 'future', 'ralf', 'opus', false, false],
      ['verify', 'future', null, null, true, false],
      ['security', 'future', null, null, true, false],
      ['commit', 'future', null, null, true, false],
    ]);
    expect(reply.phases.map((p) => p.id)).toEqual(['inbox', 'build', 'review', 'verify', 'security', 'commit', 'manual']);
    expect(reply.readOnly).toBeNull();
  });

  it('edits a draft without writing: the security pass, then a persona and the notify rule', async () => {
    await writeParent(PARENT_PLAN, 'build');
    const board = serviceOf();
    const before = await read('tickets/build/T-0130.md');
    const added = await board.flowEdit({ id: 'T-0130', part: null, chain: [], edit: { op: 'insert', phase: 'security', after: 2 } });
    expect(added.ok && added.chain).toEqual(['insert security after review']);
    const pinned = await board.flowEdit({ id: 'T-0130', part: null, chain: ['insert security after review'], edit: { op: 'persona', step: 3, persona: 'ralf' } });
    expect(pinned.ok && pinned.chain).toEqual(['insert security(ralf) after review']);
    if (pinned.ok) {
      expect(pinned.steps.find((s) => s.phase === 'security')).toMatchObject({ inserted: true, pinned: true, persona: 'ralf', model: 'opus' });
    }
    expect(await read('tickets/build/T-0130.md')).toBe(before);
  });

  it('refuses a persona that does not exist, the running gate and a delta that does not parse', async () => {
    await writeParent(PARENT_PLAN, 'build');
    const board = serviceOf();
    expect(await board.flowEdit({ id: 'T-0130', part: null, chain: [], edit: { op: 'persona', step: 2, persona: 'zed' } })).toMatchObject({ ok: false });
    expect(await board.flowEdit({ id: 'T-0130', part: null, chain: [], edit: { op: 'remove', step: 1 } })).toMatchObject({ ok: false, error: expect.stringContaining('the current gate') });
    expect(await board.flowEdit({ id: 'T-0130', part: null, chain: ['tidy up'], edit: { op: 'view' } })).toMatchObject({ ok: false, error: expect.stringContaining('not readable') });
  });

  it('save flow writes the ticket header through setChain; an empty draft returns to the standard flow', async () => {
    await writeParent(PARENT_PLAN, 'build');
    const board = serviceOf();
    expect(await board.saveFlow({ id: 'T-0130', part: null, chain: ['insert security(ralf, notify) after review'] })).toMatchObject({ ok: true });
    expect(await read('tickets/build/T-0130.md')).toContain('insert security(ralf, notify) after review');
    const reread = await board.flowOf({ id: 'T-0130', part: null });
    expect(reread.ok && reread.saved).toEqual(['insert security(ralf, notify) after review']);
    expect(await board.saveFlow({ id: 'T-0130', part: null, chain: [] })).toMatchObject({ ok: true });
    expect(await read('tickets/build/T-0130.md')).not.toMatch(/^chain:/m);
  });
});

describe('flowOf / flowEdit / saveFlow (part scope)', () => {
  it('shows the part flow from the build gate, builder first, and saves into the part line', async () => {
    await writeParent();
    const board = serviceOf();
    const flow = await board.flowOf({ id: 'T-0130', part: 1 });
    expect(flow.ok).toBe(true);
    if (!flow.ok) {
      return;
    }
    expect(flow.scope).toEqual({ kind: 'part', index: 1, title: 'Dictation hand-off' });
    expect(flow.saved).toEqual(['skip verify', 'notify build']);
    expect(flow.steps[0]).toMatchObject({ phase: 'build', state: 'current', persona: 'ben', locked: true });
    expect(flow.steps.find((s) => s.phase === 'verify')).toMatchObject({ skipped: true });

    const edited = await board.flowEdit({ id: 'T-0130', part: 1, chain: [...flow.saved], edit: { op: 'insert', phase: 'security', after: 2 } });
    expect(edited.ok).toBe(true);
    if (!edited.ok) {
      return;
    }
    expect(await board.saveFlow({ id: 'T-0130', part: 1, chain: edited.chain })).toMatchObject({ ok: true });
    const text = await read('tickets/inbox/T-0130.md');
    expect(text).toContain('insert security after review');
    // The other parts keep their text.
    expect(text).toContain('persona: paul');
    expect((await board.planParts('T-0130')).ok).toBe(true);
  });

  it('refuses a save the guard rejects, an unknown part and a part that is a ticket already', async () => {
    await writeParent();
    const board = serviceOf();
    expect(await board.saveFlow({ id: 'T-0130', part: 1, chain: ['skip build'] })).toMatchObject({ ok: false, error: expect.stringContaining('future') });
    expect(await board.flowOf({ id: 'T-0130', part: 9 })).toEqual({ ok: false, error: 'no such part in this plan' });
    expect((await board.releasePlan({ id: 'T-0130', scope: 'first' })).ok).toBe(true);
    const locked = await board.flowOf({ id: 'T-0130', part: 0 });
    expect(locked.ok && locked.readOnly).toContain('released as a ticket');
    expect(await board.saveFlow({ id: 'T-0130', part: 0, chain: [] })).toMatchObject({ ok: false });
  });
});

describe('flowDraftContext', () => {
  it('hands Paul the standard flow, the flow now and the crew', async () => {
    await writeParent();
    const ctx = await serviceOf().flowDraftContext({ id: 'T-0130', part: 0 });
    expect(ctx.ok).toBe(true);
    if (ctx.ok) {
      expect(ctx.text).toContain('Standard flow (phase ids): inbox -> build -> review -> verify -> security -> commit -> done');
      expect(ctx.text).toContain('part "Capture window"');
      expect(ctx.text).toContain('- ralf (Ralf)');
    }
  });
});

describe('manual steps and the human persona (E10-6)', () => {
  const YOU = `---\ntitle: You\nkind: human\nrole: custom\nworker: opencode\n---\n\nYou.\n`;

  async function writeYou(): Promise<void> {
    await fsp.mkdir(path.join(vaultDir, 'tickets', '_meta', 'personas', 'you'), { recursive: true });
    await fsp.writeFile(path.join(vaultDir, 'tickets', '_meta', 'personas', 'you', 'persona.md'), YOU, 'utf8');
  }

  async function park(phase: string): Promise<void> {
    const rel = path.join(vaultDir, 'tickets', phase, 'T-0130.md');
    const text = await fsp.readFile(rel, 'utf8');
    await fsp.writeFile(
      rel,
      patchTicketFile(text, { to: phase, from: null, now: new Date('2026-11-04T10:00:00Z'), actor: 'agent@fleet', action: 'parked for You', setAwaiting: 'you' }),
      'utf8',
    );
  }

  it('offers the manual step as a gate to add and lists you as a human persona', async () => {
    await writeYou();
    await writeParent(PARENT_PLAN, 'build');
    const reply = await serviceOf().flowOf({ id: 'T-0130', part: null });
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.phases.map((p) => p.id)).toContain('manual');
      expect(reply.personas.find((p) => p.id === 'you')).toMatchObject({ kind: 'human', model: '' });
      expect(reply.personas.find((p) => p.id === 'ben')).toMatchObject({ kind: 'agent' });
    }
  });

  it('adds a manual step for you after review, shows it as the owner\'s gate and saves it', async () => {
    await writeYou();
    await writeParent(PARENT_PLAN, 'build');
    const board = serviceOf();
    const added = await board.flowEdit({ id: 'T-0130', part: null, chain: [], edit: { op: 'insert', phase: 'manual', after: 2 } });
    expect(added.ok && added.chain).toEqual(['insert manual after review']);
    const pinned = await board.flowEdit({ id: 'T-0130', part: null, chain: ['insert manual after review'], edit: { op: 'persona', step: 3, persona: 'you' } });
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) {
      return;
    }
    expect(pinned.chain).toEqual(['insert manual(you) after review']);
    expect(pinned.steps.find((s) => s.phase === 'manual')).toMatchObject({ inserted: true, persona: 'you', owner: true, title: 'Manual step' });
    expect(await board.saveFlow({ id: 'T-0130', part: null, chain: pinned.chain })).toMatchObject({ ok: true });
    expect(await read('tickets/build/T-0130.md')).toContain('insert manual(you) after review');
  });

  it('refuses an agent persona on a manual step', async () => {
    await writeYou();
    await writeParent(PARENT_PLAN, 'build');
    const refused = await serviceOf().flowEdit({ id: 'T-0130', part: null, chain: ['insert manual(ben) after review'], edit: { op: 'view' } });
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('ben is an agent') });
  });

  it('Accept finishes the manual step: the chain goes on, the park is gone, the Log names the owner', async () => {
    await writeParent(PARENT_PLAN, 'review');
    await park('review');
    const board = serviceOf();
    expect(await read('tickets/review/T-0130.md')).toMatch(/^awaiting: /m);
    expect(await board.acceptTicket({ id: 'T-0130' })).toMatchObject({ ok: true });
    const text = await read(await fileOf('T-0130'));
    expect(text).not.toMatch(/^awaiting:/m);
    expect(text).toContain('manual step finished by owner@test');
    expect(await fileOf('T-0130')).toContain('verify/T-0130.md');
  });

  it('Send back returns the ticket to the previous agent phase with the note, and the park is gone', async () => {
    await fsp.writeFile(
      path.join(vaultDir, 'tickets', '_meta', 'pipeline.md'),
      PIPELINE.replace('{ id: build, title: Build, handover: manual, persona: ben }', '{ id: build, title: Build, handover: agent build-default, persona: ben }'),
      'utf8',
    );
    await writeParent(PARENT_PLAN, 'review');
    await park('review');
    const board = serviceOf();
    expect(await board.sendBack({ id: 'T-0130', note: 'The spacing is off' })).toMatchObject({ ok: true });
    const text = await read(await fileOf('T-0130'));
    expect(text).not.toMatch(/^awaiting:/m);
    expect(text).toContain('sent back: The spacing is off');
    expect(await fileOf('T-0130')).toContain('build/T-0130.md');
  });

  it('the first flow read creates personas/you once, and a plain refresh leaves the vault alone', async () => {
    await writeParent(PARENT_PLAN, 'build');
    const board = serviceOf();
    await board.refresh();
    expect(await listMarkdownFiles(vaultDir)).not.toContain('tickets/_meta/personas/you/persona.md');
    await board.flowOf({ id: 'T-0130', part: null });
    const path1 = 'tickets/_meta/personas/you/persona.md';
    const created = await read(path1);
    expect(created).toContain('kind: human');
    expect(created).toContain('title: You');
    await fsp.writeFile(path.join(vaultDir, ...path1.split('/')), created.replace('title: You', 'title: Henrik'), 'utf8');
    await board.flowOf({ id: 'T-0130', part: null });
    expect(await read(path1)).toContain('title: Henrik');
    const personas = await board.listPersonas();
    expect(personas.find((p) => p.id === 'you')).toMatchObject({ kind: 'human', title: 'Henrik' });
  });
});
