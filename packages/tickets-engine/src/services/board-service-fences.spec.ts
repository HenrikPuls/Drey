import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EngineBoardService } from './board-service';
import type { EngineHost, EngineVault, FleetPort } from './host';
import { TicketsGit } from '../core/tickets-git';
import { newTicketFileText } from '../core/ticket-files';
import { planSectionOf } from '../core/plan-delta';
import { normalizeFleetCaps, normalizeFleetHandover, normalizeFleetPools } from '../fleet/protocol';

/**
 * Milestone 148 (E10-7): a Mermaid plan through the real board service on
 * a temp vault -- the shape turn writes it (setPlan), the approval screen
 * reads its parts, the owner edits the list, the release mints the part
 * tickets. The diagram's lines look like every structure the readers know;
 * none of them may count, and the fence must survive every write verbatim.
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

const DIAGRAM = [
  '```mermaid',
  'flowchart TD',
  '  A[Capture] --> B{Dictation?}',
  '## Plan',
  '### Parts',
  '- [ ] Decoy part',
  '  persona: mallory',
  '## Verification',
  '- [x] `echo decoy`',
  '## Log',
  "- '2099-01-01T00:00:00Z' owner@host — plan-review -> build",
  '---',
  '```',
].join('\n');

const PLAN = [
  '### Goal',
  '',
  'Capture by voice.',
  '',
  DIAGRAM,
  '',
  '### Parts',
  '',
  '- [ ] Capture window',
  '  persona: ben',
  '- [ ] Dictation hand-off',
  '  persona: ben',
  '- [ ] Tidy-up',
  '  persona: paul',
].join('\n');

let vaultDir = '';
let vault: EngineVault;

beforeEach(async () => {
  vaultDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-fences-'));
  vault = { id: 'v', name: 'vault', path: vaultDir, exists: true, active: true };
  await fsp.mkdir(path.join(vaultDir, 'tickets', '_meta'), { recursive: true });
  await fsp.writeFile(path.join(vaultDir, 'tickets', '_meta', 'pipeline.md'), PIPELINE, 'utf8');
  for (const [id, title] of [
    ['ben', 'Ben'],
    ['paul', 'Paul'],
  ] as const) {
    await fsp.mkdir(path.join(vaultDir, 'tickets', '_meta', 'personas', id), { recursive: true });
    await fsp.writeFile(
      path.join(vaultDir, 'tickets', '_meta', 'personas', id, 'persona.md'),
      `---\ntitle: ${title}\nrole: builder\nworker: opencode\nmodels:\n  default: sonnet\n  pool: [sonnet]\n  router: off\ncolor: '#a78bfa'\n---\n\nWho.\n`,
      'utf8',
    );
  }
  const text = newTicketFileText({
    id: 'T-0130',
    title: 'Voice capture for tickets',
    repo: 'drey',
    priority: 'high',
    rank: 5000,
    firstPhase: 'inbox',
    now: new Date('2026-11-02T10:00:00Z'),
    actor: 'owner@test',
    description: `Capture by voice.\n\n${DIAGRAM}`,
  });
  await fsp.mkdir(path.join(vaultDir, 'tickets', 'inbox'), { recursive: true });
  await fsp.writeFile(path.join(vaultDir, 'tickets', 'inbox', 'T-0130.md'), text, 'utf8');
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

function serviceOf(): EngineBoardService {
  const abs = (p: string): string => path.join(vaultDir, ...p.split('/'));
  const write = async (_v: string, p: string, text: string): Promise<void> => {
    await fsp.mkdir(path.dirname(abs(p)), { recursive: true });
    await fsp.writeFile(abs(p), text, 'utf8');
  };
  const host: EngineHost = {
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
  const git = new TicketsGit(() => 'git', async () => {
    throw new Error('no git in the spec');
  });
  const fleet: FleetPort = {
    runs: async () => [],
    start: async () => ({ ok: false, error: 'not in the spec' }),
    configureChain: async () => undefined,
  };
  return new EngineBoardService(
    host,
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

const read = (rel: string): Promise<string> => fsp.readFile(path.join(vaultDir, ...rel.split('/')), 'utf8');

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

describe('a Mermaid plan through the board service', () => {
  it('the shape turn writes the plan, the approval screen sees only the real parts', async () => {
    const board = serviceOf();
    expect((await board.setPlan({ id: 'T-0130', plan: PLAN })).ok).toBe(true);
    const text = await read('tickets/inbox/T-0130.md');
    expect(planSectionOf(text)).toBe(PLAN);
    // The description's diagram and the plan's diagram, both verbatim.
    expect(occurrences(text, DIAGRAM)).toBe(2);
    const reply = await board.planParts('T-0130');
    expect(reply.ok).toBe(true);
    if (!reply.ok) {
      return;
    }
    expect(reply.parts.map((p) => [p.title, p.persona])).toEqual([
      ['Capture window', 'ben'],
      ['Dictation hand-off', 'ben'],
      ['Tidy-up', 'paul'],
    ]);
    expect(reply.personas.map((p) => p.id)).not.toContain('mallory');
  });

  it('edits to the parts list leave the diagram alone', async () => {
    const board = serviceOf();
    await board.setPlan({ id: 'T-0130', plan: PLAN });
    expect((await board.editPlanParts({ id: 'T-0130', edit: { op: 'persona', index: 0, persona: 'paul' } })).ok).toBe(true);
    expect((await board.editPlanParts({ id: 'T-0130', edit: { op: 'move', from: 2, to: 0 } })).ok).toBe(true);
    expect((await board.editPlanParts({ id: 'T-0130', edit: { op: 'delete', index: 1 } })).ok).toBe(true);
    const text = await read('tickets/inbox/T-0130.md');
    expect(occurrences(text, DIAGRAM)).toBe(2);
    const reply = await board.planParts('T-0130');
    expect(reply.ok && reply.parts.map((p) => p.title)).toEqual(['Tidy-up', 'Dictation hand-off']);
  });

  it('a second shape reply replaces the whole plan chapter, diagram included, and the Log survives', async () => {
    const board = serviceOf();
    await board.setPlan({ id: 'T-0130', plan: PLAN });
    const replacement = ['### Goal', '', 'Smaller.', '', DIAGRAM.replace('Capture', 'Record')].join('\n');
    expect((await board.setPlan({ id: 'T-0130', plan: replacement })).ok).toBe(true);
    const text = await read('tickets/inbox/T-0130.md');
    expect(planSectionOf(text)).toBe(replacement);
    expect(text).toContain('A[Record]');
    expect(occurrences(text, 'A[Capture]')).toBe(1); // the description's diagram only
    expect(text.indexOf('\n## Log\n', text.lastIndexOf('```'))).toBeGreaterThan(0);
    expect((await board.planParts('T-0130')).ok && (await board.planParts('T-0130'))).toMatchObject({ parts: [] });
  });

  it('the release mints one ticket per real part and keeps the parent file intact', async () => {
    const board = serviceOf();
    await board.setPlan({ id: 'T-0130', plan: PLAN });
    const reply = await board.releasePlan({ id: 'T-0130', scope: 'all' });
    expect(reply.ok).toBe(true);
    if (!reply.ok) {
      return;
    }
    expect(reply.tickets).toHaveLength(3);
    const parent = (await listMarkdownFiles(vaultDir)).find((f) => f.endsWith('/T-0130.md'))!;
    const text = await read(parent);
    expect(occurrences(text, DIAGRAM)).toBe(2);
    const titles: string[] = [];
    for (const id of reply.tickets) {
      const file = (await listMarkdownFiles(vaultDir)).find((f) => f.endsWith(`/${id}.md`))!;
      const minted = await read(file);
      expect(minted).toContain('parent: T-0130');
      titles.push(/^title: "?(.+?)"?$/m.exec(minted)![1]!);
    }
    expect(titles).toEqual(['Capture window', 'Dictation hand-off', 'Tidy-up']);
  });
});
