import { execFileSync } from 'node:child_process';
import { promises as fsp, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EngineBoardService } from './board-service';
import type { EngineHost, EngineVault, FleetPort } from './host';
import { TicketsGit } from '../core/tickets-git';
import { normalizeFleetCaps, normalizeFleetHandover, normalizeFleetPools, type RunRequest } from '../fleet/protocol';
import { assertDkVersion, MIN_DK_VERSION } from '../store/dk-process';

/**
 * E14-4b: the board's write moves against a REAL `dk` and a SCRATCH store —
 * capture, header edits, the raw save with its conflict, moves (transition,
 * accept = archive, send back, unarchive), the parts release (children first,
 * parent last, resumable) and the refusals of the fleet's own writes. The meta
 * vault (pipeline, personas) is a temp folder; nothing of the owner's repos or
 * store is touched. Skipped, with the reason, when `dk` is missing or too old.
 */
const bin = process.env['DREY_DK_BIN'] ?? 'dk';

function probe(): { ok: true } | { ok: false; reason: string } {
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true });
    assertDkVersion(/version:\s*(\S+)/.exec(out)?.[1] ?? out.trim(), bin);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : `dk was not found ("${bin}"); set DREY_DK_BIN to a dk >= ${MIN_DK_VERSION}` };
  }
}
const found = probe();
if (!found.ok) {
  console.warn(`[board service dricket] SKIPPED: ${found.reason}`);
}

const PIPELINE = `---
phases:
  - { id: inbox, title: Inbox, handover: manual }
  - { id: build, title: Build, claim: true, handover: agent build-default }
  - { id: commit, title: Commit, claim: true, handover: manual }
  - { id: done, title: Done, handover: none }
priorities: [urgent, high, normal, low]
---
The pipeline.
`;

const PLAN = `Goal text.

### Parts

- [ ] Capture window
  persona: ben
- [ ] Dictation hand-off
  chain: skip commit; notify build
- [ ] Tidy-up
  persona: paul
`;

describe.skipIf(!found.ok)('the board service writing through dk', { timeout: 240_000 }, () => {
  let root = '';
  let storeDir = '';
  let vaultDir = '';
  let vault: EngineVault;
  let service: EngineBoardService;
  const saved: Record<string, string | undefined> = {};
  const envSet = (key: string, value: string): void => {
    if (!(key in saved)) {
      saved[key] = process.env[key];
    }
    process.env[key] = value;
  };
  const dk = (args: string[]): string => execFileSync(bin, args, { windowsHide: true, encoding: 'utf8', stdio: 'pipe' });
  const dkShow = (id: string): string => (JSON.parse(dk(['show', id, '--json'])) as { data: { content: string } }).data.content;
  const field = (id: string, key: string): string => new RegExp(`^${key}: (.*)$`, 'm').exec(dkShow(id))?.[1]?.trim() ?? '';

  const abs = (p: string): string => path.join(vaultDir, ...p.split('/'));
  const config: Record<string, string> = {};

  function hostOf(): EngineHost {
    const write = async (_v: string, p: string, text: string): Promise<void> => {
      await fsp.mkdir(path.dirname(abs(p)), { recursive: true });
      await fsp.writeFile(abs(p), text, 'utf8');
    };
    const list = async (dir = ''): Promise<string[]> => {
      const out: string[] = [];
      for (const entry of await fsp.readdir(dir === '' ? vaultDir : abs(dir), { withFileTypes: true }).catch(() => [])) {
        const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          out.push(...(await list(rel)));
        } else if (entry.name.endsWith('.md')) {
          out.push(rel);
        }
      }
      return out;
    };
    return {
      listVaults: async () => [vault],
      read: async (_v, p) => fsp.readFile(abs(p), 'utf8'),
      writeAnnounced: write,
      write,
      listMarkdownFiles: () => list(),
      resolveAssetPath: (_v, p) => abs(p),
      announceChanges: () => undefined,
      markManaged: () => undefined,
      configGet: async <T>(key: string) => config[key] as T | undefined,
      configSet: async () => undefined,
      emitBoardChanged: () => undefined,
      log: () => undefined,
      userRoot: path.join(root, 'userroot'),
      pickFolder: async () => null,
      revealPath: async () => '',
      launchInConsole: () => undefined,
    };
  }

  beforeAll(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'drey-board-dk-'));
    const home = path.join(root, 'home');
    mkdirSync(home);
    storeDir = path.join(root, 'store');
    for (const [k, v] of Object.entries({
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, 'AppData'),
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Board Test',
      GIT_AUTHOR_EMAIL: 'board@test.invalid',
      GIT_COMMITTER_NAME: 'Board Test',
      GIT_COMMITTER_EMAIL: 'board@test.invalid',
      DK_DATA_DIR: path.join(root, 'data'),
      DK_OWNER: 'owner@scratch',
    })) {
      envSet(k, v);
    }
    dk(['init', storeDir, 't']);
    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: storeDir, windowsHide: true, stdio: 'pipe' });
    };
    git(['checkout', '-q', 'main']);
    const tomlPath = path.join(storeDir, 'dricket.toml');
    const toml = readFileSync(tomlPath, 'utf8')
      .replace(/\[transitions\.agent\][\s\S]*?(?=\n\[|$)/, '')
      .replace('values = ["critical", "high", "normal", "low"]', 'values = ["urgent", "high", "normal", "low"]');
    writeFileSync(
      tomlPath,
      `${toml}\n[stages]\nvalues = ["inbox", "build", "commit", "done"]\ninitial = "inbox"\nterminal = ["done"]\nclaim = ["build", "commit"]\ncancelled = "cancelled"\n`,
    );
    git(['commit', '-q', '-am', 'stages and priorities']);
    git(['checkout', '-q', 'tickets']);
    envSet('DK_STORE', storeDir);

    vaultDir = path.join(root, 'meta');
    vault = { id: 'v', name: 'vault', path: vaultDir, exists: true, active: true };
    await fsp.mkdir(abs('tickets/_meta'), { recursive: true });
    await fsp.writeFile(abs('tickets/_meta/pipeline.md'), PIPELINE, 'utf8');
    for (const [id, model] of [['ben', 'sonnet'], ['paul', 'opus']] as const) {
      await fsp.mkdir(abs(`tickets/_meta/personas/${id}`), { recursive: true });
      await fsp.writeFile(
        abs(`tickets/_meta/personas/${id}/persona.md`),
        `---\ntitle: ${id}\nrole: builder\nworker: opencode\nmodels:\n  default: ${model}\n  pool: [${model}]\n  router: off\ncolor: '#a78bfa'\n---\n\nWho.\n`,
        'utf8',
      );
    }
    Object.assign(config, { backend: 'dricket', 'dk.path': bin === 'dk' ? '' : bin, 'dk.store': storeDir, 'dk.dataDir': path.join(root, 'data') });
    const git2 = new TicketsGit(() => 'git', async () => {
      throw new Error('no git in the spec');
    });
    const fleet: FleetPort = { runs: async () => [], start: async () => ({ ok: false, error: 'not in the spec' }), configureChain: async () => undefined };
    service = new EngineBoardService(hostOf(), git2, 'opencode', 'accept-edits', '', fleet, '/fleet', normalizeFleetCaps({}), normalizeFleetPools({}), normalizeFleetHandover({}), 'owner@test', {});
  }, 120_000);

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    service?.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  const phaseOf = async (id: string): Promise<string | null> => {
    const board = await service.snapshot();
    return board.columns.find((c) => c.tickets.some((t) => t.id === id))?.phase.id ?? null;
  };
  const rev = (id: string): number => Number(field(id, 'rev'));

  it('captures a ticket: dk allocates the number, one put fills the document', async () => {
    const reply = await service.createTicket({ title: 'Voice: capture', priority: 'high', repo: null, description: 'Capture by voice.' });
    expect(reply).toMatchObject({ ok: true, id: 'T-0001' });
    expect(field('t-1', 'stage')).toBe('inbox');
    expect(field('t-1', 'priority')).toBe('high');
    expect(dkShow('t-1')).toContain('Capture by voice.');
    expect(rev('t-1')).toBe(1);
    expect(await phaseOf('T-0001')).toBe('inbox');
  });

  it('edits the header and the body through put, one commit each, rev + 1', async () => {
    expect(await service.setPriority({ id: 'T-0001', priority: 'urgent' })).toMatchObject({ ok: true });
    expect(field('t-1', 'priority')).toBe('urgent');
    expect(rev('t-1')).toBe(2);
    expect(await service.setTrack({ id: 'T-0001', track: 'shape' })).toMatchObject({ ok: true });
    expect(field('t-1', 'x-track')).toBe('shape');
    expect(await service.setBlockedBy({ id: 'T-0001', blockedBy: [] })).toMatchObject({ ok: true });
    expect(await service.setPlan({ id: 'T-0001', plan: PLAN })).toMatchObject({ ok: true });
    expect(dkShow('t-1')).toContain('### Parts');
    expect(rev('t-1')).toBe(4);
  });

  it('refuses a raw save made on a stale text, and reports a ticket that moved on (exit 12) as a conflict', async () => {
    const read = await service.readTicket('T-0001');
    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }
    expect(await service.setPriority({ id: 'T-0001', priority: 'high' })).toMatchObject({ ok: true });
    const stale = await service.saveTicket({ id: 'T-0001', text: read.text, baseRevision: read.revision });
    expect(stale).toMatchObject({ ok: false, conflict: true });

    const fresh = await service.readTicket('T-0001');
    if (!fresh.ok) {
      throw new Error('read failed');
    }
    // A foreign write lands between the service's read and its put: dk answers exit 12.
    const before = rev('t-1');
    const source = (service as unknown as { storeBoard: { writeLegacy: (...a: unknown[]) => Promise<unknown> } }).storeBoard;
    const original = source.writeLegacy.bind(source);
    const spy = vi.spyOn(source, 'writeLegacy').mockImplementationOnce(async (...args: unknown[]) => {
      dk(['put', 't-1', '-F', writeTemp(dkShow('t-1').replace('priority: high', 'priority: low')), '--claim', '--if-version', String(before)]);
      return original(...args);
    });
    const raced = await service.saveTicket({ id: 'T-0001', text: fresh.text.replace('Capture by voice.', 'Changed.'), baseRevision: fresh.revision });
    spy.mockRestore();
    expect(raced).toMatchObject({ ok: false, conflict: true });
    expect(dkShow('t-1')).not.toContain('Changed.');
    expect(field('t-1', 'priority')).toBe('low');
    await service.setPriority({ id: 'T-0001', priority: 'high' });
  });

  it('moves a card, accepts it into the terminal column and archives it; unarchive brings it back', async () => {
    expect(await service.transition({ id: 'T-0001', from: 'inbox', to: 'build' })).toMatchObject({ ok: true });
    expect(field('t-1', 'stage')).toBe('build');
    expect(field('t-1', 'x-entered-build')).not.toBe('');
    expect(dkShow('t-1')).toContain('inbox -> build');
    expect(await phaseOf('T-0001')).toBe('build');

    expect(await service.transition({ id: 'T-0001', from: 'build', to: 'commit' })).toMatchObject({ ok: true });
    const sent = await service.sendBack({ id: 'T-0001', note: 'tests missing' });
    expect(sent).toMatchObject({ ok: true });
    expect(field('t-1', 'stage')).toBe('build');
    expect(dkShow('t-1')).toContain('sent back: tests missing');

    expect(await service.transition({ id: 'T-0001', from: 'build', to: 'done' })).toMatchObject({ ok: true });
    expect(await service.acceptTicket({ id: 'T-0001' })).toMatchObject({ ok: true });
    expect(field('t-1', 'labels')).toContain('archived');
    expect(field('t-1', 'stage')).toBe('done');
    expect(await phaseOf('T-0001')).toBeNull();

    expect(await service.unarchive({ id: 'T-0001', to: 'inbox' })).toMatchObject({ ok: true });
    expect(field('t-1', 'labels')).not.toContain('archived');
    expect(await phaseOf('T-0001')).toBe('inbox');
  });

  it('releases the parts children first, parent last, and resumes after a break', async () => {
    const first = await service.releasePlan({ id: 'T-0001', scope: 'first' });
    expect(first).toMatchObject({ ok: true, tickets: ['T-0002'] });
    expect(field('t-2', 'parent')).toBe('t-1');
    expect(field('t-2', 'stage')).toBe('build');
    expect(field('t-2', 'x-persona')).toBe('ben');
    expect(dkShow('t-1')).toContain('plan released');

    // A release that broke between add and put leaves a titled stub: the next approval fills it.
    dk(['add', '--unclaimed', '-m', 'Dictation hand-off', '--parent', 't-1', '--depends', 't-2']);
    expect(dkShow('t-3')).toContain('(no description)');
    const rest = await service.releasePlan({ id: 'T-0001', scope: 'all' });
    expect(rest).toMatchObject({ ok: true, tickets: ['T-0003', 'T-0004'] });
    expect(dkShow('t-3')).not.toContain('(no description)');
    expect(field('t-3', 'stage')).toBe('build');
    expect(field('t-3', 'depends')).toBe('t-2');
    expect(field('t-4', 'depends')).toBe('t-3');
    expect(field('t-4', 'x-persona')).toBe('paul');
    expect(await service.releasePlan({ id: 'T-0001', scope: 'all' })).toMatchObject({ ok: false });
  });

  it('takes a claim and gives it back through dk (E14-5): dk alone decides', async () => {
    expect(await service.setClaim({ id: 'T-0002', mode: 'takeover', actor: 'henrik' })).toMatchObject({ ok: true });
    expect(field('t-2', 'owner')).toBe('henrik');
    // A second human cannot take over a live lease: dk's exit 11 is the answer, not a TypeScript rule.
    expect(await service.setClaim({ id: 'T-0002', mode: 'takeover', actor: 'ben' })).toMatchObject({ ok: false, error: expect.stringContaining('claimed') });
    expect(await service.setClaim({ id: 'T-0002', mode: 'release', actor: 'henrik' })).toMatchObject({ ok: true });
    expect(field('t-2', 'owner')).toBe('');
  });

  it('starts a run on a dricket ticket: the request carries the store, the runner claims (E14-5)', async () => {
    const kt = abs('kt').split(path.sep).join('/');
    await fsp.writeFile(abs('tickets/_meta/repos.md'), `---\nrepos:\n  kt:\n    url: https://example.test/kt.git\n    path: '${kt}'\n---\n`, 'utf8');
    const text = dkShow('t-2')
      .replace(/^repos:.*/m, 'repos: kt')
      .replace('## Log', '## Plan\n\n### Acceptance criteria\n\n- [ ] `echo ok`\n\n## Log');
    dk(['put', 't-2', '-F', writeTemp(text), '--claim', '--if-version', String(rev('t-2'))]);
    await fsp.mkdir(abs('tickets/_meta/prompts'), { recursive: true });
    await fsp.writeFile(abs('tickets/_meta/prompts/build-default.md'), 'Build the ticket.\n', 'utf8');
    const started: RunRequest[] = [];
    const fleet: FleetPort = {
      runs: async () => [],
      start: async (request) => {
        started.push(request);
        return { ok: false, error: 'stub: not spawning' };
      },
      configureChain: async () => undefined,
    };
    const runner = new EngineBoardService(hostOf(), new TicketsGit(() => 'git', async () => ''), 'opencode', 'accept-edits', '', fleet, '/fleet', normalizeFleetCaps({}), normalizeFleetPools({}), normalizeFleetHandover({}), 'owner@test', {});
    try {
      const reply = await runner.startRun({ ticketId: 'T-0002', workerChoice: null, permissionMode: 'accept-edits', handover: null, interactive: null });
      expect(reply).toMatchObject({ ok: false, error: 'stub: not spawning' });
      expect(started).toHaveLength(1);
      expect(started[0]!.dk).toMatchObject({ store: storeDir, trailers: false, parkStage: null, retreatStage: 'inbox' });
      expect(started[0]!.ticketId).toBe('T-0002');
    } finally {
      runner.dispose();
    }
  });

  it('keeps the chain off on the dricket backend until E14-5b', async () => {
    expect(await service.chainRefusal()).toContain('E14-5b');
  });

  function writeTemp(text: string): string {
    const file = path.join(root, `put-${Date.now()}.md`);
    writeFileSync(file, text, 'utf8');
    return file;
  }
});
