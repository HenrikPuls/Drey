import { execFileSync } from 'node:child_process';
import { promises as fsp, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EngineBoardService } from './board-service';
import type { EngineHost, EngineVault, FleetPort } from './host';
import { TicketsGit } from '../core/tickets-git';
import { normalizeFleetCaps, normalizeFleetHandover, normalizeFleetPools } from '../fleet/protocol';
import { needsOf } from '../server/needs';
import { assertDkVersion, MIN_DK_VERSION } from '../store/dk-process';

/**
 * The defects of the sweep of 2026-11-05 (D-11, D-12, D-13) against a REAL `dk`
 * and a SCRATCH store seeded the way the sweep seeded it: `dk init`'s own
 * priority vocabulary, tickets and comments written from a terminal. Temp dir +
 * temp HOME, never the owner's repos. Skipped, with the reason, when `dk` is
 * missing or too old.
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
  console.warn(`[board service sweep] SKIPPED: ${found.reason}`);
}

const PIPELINE = `---
phases:
  - { id: inbox, title: Inbox, handover: manual }
  - { id: build, title: Build, claim: true, handover: agent build-default }
  - { id: commit, title: Commit, claim: true, handover: manual }
  - { id: done, title: Done, handover: none }
---
The pipeline: no priorities of its own, so the files vocabulary would apply.
`;

describe.skipIf(!found.ok)('the sweep defects on a scratch dk store', { timeout: 240_000 }, () => {
  let root = '';
  let storeDir = '';
  let vaultDir = '';
  let vault: EngineVault;
  let service: EngineBoardService;
  const saved: Record<string, string | undefined> = {};
  const config: Record<string, string> = {};
  const storeChanges: { checkout: string; changed: readonly string[]; deleted: readonly string[] }[] = [];
  const envSet =(key: string, value: string): void => {
    if (!(key in saved)) {
      saved[key] = process.env[key];
    }
    process.env[key] = value;
  };
  const dk = (args: string[]): string => execFileSync(bin, args, { windowsHide: true, encoding: 'utf8', stdio: 'pipe' });
  const abs = (p: string): string => path.join(vaultDir, ...p.split('/'));

  function hostOf(): EngineHost {
    const write = async (_v: string, p: string, text: string): Promise<void> => {
      await fsp.mkdir(path.dirname(abs(p)), { recursive: true });
      await fsp.writeFile(abs(p), text, 'utf8');
    };
    return {
      listVaults: async () => [vault],
      read: async (_v, p) => fsp.readFile(abs(p), 'utf8'),
      writeAnnounced: write,
      write,
      listMarkdownFiles: async () => [],
      resolveAssetPath: (_v, p) => abs(p),
      announceChanges: () => undefined,
      announceStoreChanges: (checkout, changed, deleted) => {
        storeChanges.push({ checkout, changed, deleted });
      },
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
    root = mkdtempSync(path.join(os.tmpdir(), 'drey-board-sweep-'));
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
      GIT_AUTHOR_NAME: 'Sweep Test',
      GIT_AUTHOR_EMAIL: 'sweep@test.invalid',
      GIT_COMMITTER_NAME: 'Sweep Test',
      GIT_COMMITTER_EMAIL: 'sweep@test.invalid',
      DK_DATA_DIR: path.join(root, 'data'),
      DK_OWNER: 'owner@scratch',
    })) {
      envSet(k, v);
    }
    dk(['init', storeDir, 't']);
    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: storeDir, windowsHide: true, stdio: 'pipe' });
    };
    // dk's own vocabulary stays (critical, high, normal, low); only the stages are the board's.
    git(['checkout', '-q', 'main']);
    const tomlPath = path.join(storeDir, 'dricket.toml');
    const toml = readFileSync(tomlPath, 'utf8').replace(/\[transitions\.agent\][\s\S]*?(?=\n\[|$)/, '');
    writeFileSync(tomlPath, `${toml}\n[stages]\nvalues = ["inbox", "build", "commit", "done"]\ninitial = "inbox"\nterminal = ["done"]\nclaim = ["build", "commit"]\ncancelled = "cancelled"\n`);
    git(['commit', '-q', '-am', 'stages']);
    git(['checkout', '-q', 'tickets']);
    envSet('DK_STORE', storeDir);

    vaultDir = path.join(root, 'meta');
    vault = { id: 'v', name: 'vault', path: vaultDir, exists: true, active: true };
    await fsp.mkdir(abs('tickets/_meta'), { recursive: true });
    await fsp.writeFile(abs('tickets/_meta/pipeline.md'), PIPELINE, 'utf8');
    Object.assign(config, { backend: 'dricket', 'dk.path': bin === 'dk' ? '' : bin, 'dk.store': storeDir, 'dk.dataDir': path.join(root, 'data') });
    const fleet: FleetPort = { runs: async () => [], start: async () => ({ ok: false, error: 'not in the spec' }), configureChain: async () => undefined };
    const git2 = new TicketsGit(() => 'git', async () => {
      throw new Error('no git in the spec');
    });
    service = new EngineBoardService(hostOf(), git2, 'opencode', 'accept-edits', '', fleet, '/fleet', normalizeFleetCaps({}), normalizeFleetPools({}), normalizeFleetHandover({}), 'owner@test');

    dk(['add', '--prefix', 't', '-m', 'Export the vault', '--unclaimed']);
    dk(['add', '--prefix', 't', '-m', 'Spellcheck for daily notes', '--unclaimed']);
    dk(['add', '--prefix', 't', '-m', 'Rename a folder', '--unclaimed']);
  }, 120_000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    service?.dispose();
    await service?.idle();
    rmSync(root, { recursive: true, force: true });
  });

  describe("D-28: the store checkout's changed files", () => {
    const reportedPaths = (): readonly string[] => storeChanges.flatMap((change) => change.changed);

    it('a ticket the board creates is named, by its document path in the checkout', async () => {
      await service.snapshot();
      const created = await service.createTicket({ title: 'Made by the board', priority: 'normal', repo: null, description: '' });
      expect(created).toMatchObject({ ok: true });
      const id = (created as unknown as { id: string }).id;
      const number = Number(id.slice(2));
      await vi.waitFor(() => {
        expect(reportedPaths()).toContain(`tickets/t/0000/t-${number}/ticket.md`);
      }, { timeout: 30_000, interval: 100 });
      expect(storeChanges.every((change) => change.checkout === storeDir)).toBe(true);
    });

    it("a terminal's dk put is named too, though no call of the board wrote it", async () => {
      await service.snapshot();
      storeChanges.length = 0;
      dk(['add', '--prefix', 't', '-m', 'Made in a terminal', '--unclaimed']);
      let document = '';
      await vi.waitFor(() => {
        document = reportedPaths().find((p) => /^tickets\/t\/0000\/t-\d+\/ticket\.md$/.test(p)) ?? '';
        expect(document).not.toBe('');
      }, { timeout: 30_000, interval: 100 });
      const id = document.split('/')[3]!;
      storeChanges.length = 0;
      const text = readFileSync(path.join(storeDir, ...document.split('/')), 'utf8');
      const rev = /^rev:\s*(\d+)/m.exec(text)?.[1] ?? '0';
      const put = path.join(root, 'put.md');
      writeFileSync(put, `${text}\nFrom a terminal.\n`);
      dk(['put', id, '-F', put, '--claim', '--if-version', rev]);
      await vi.waitFor(() => {
        expect(reportedPaths()).toContain(document);
      }, { timeout: 30_000, interval: 100 });
    });
  });

  describe('D-11: the priority vocabulary', () => {
    it('reads the store\'s own vocabulary, so the menu offers what dk accepts', async () => {
      const board = await service.snapshot();
      expect(board.priorities.order).toEqual(['critical', 'high', 'normal', 'low']);
      expect(board.priorities.default).toBe('normal');
    });

    it('writes the first value of that vocabulary through dk', async () => {
      expect(await service.setPriority({ id: 'T-0001', priority: 'critical' })).toMatchObject({ ok: true });
      const shown = (JSON.parse(dk(['show', 't-1', '--json'])) as { data: { content: string } }).data.content;
      expect(shown).toMatch(/^priority: critical$/m);
      const card = (await service.snapshot()).columns.flatMap((c) => c.tickets).find((t) => t.id === 'T-0001');
      expect(card?.meta.priority).toBe('critical');
      expect(card?.issues ?? []).toEqual([]);
    });
  });

  describe('D-12: comments on a dricket ticket', () => {
    it('reach the thread through ticketComments, as written', async () => {
      dk(['comment', 't-2', '-m', 'Dictionary ships with the app.']);
      const comments = await service.ticketComments('T-0002');
      expect(comments.map((c) => c.text)).toEqual(['Dictionary ships with the app.']);
    });

    it('raise a Needs-you row from a "Decision needed" comment on the snapshot alone', async () => {
      dk(['comment', 't-1', '-m', 'Decision needed: CSV or JSON for the export?']);
      const board = await service.snapshot();
      const need = needsOf(board, []).find((item) => item.ticketId === 'T-0001');
      expect(need).toMatchObject({ kind: 'needs-decision', text: 'CSV or JSON for the export?' });
    });

    it('closes that row when the decision is answered', async () => {
      expect(await service.answerNeed({ id: 'T-0001', text: 'CSV.' })).toMatchObject({ ok: true });
      const board = await service.snapshot();
      expect(needsOf(board, []).find((item) => item.ticketId === 'T-0001')).toBeUndefined();
    });
  });

  describe('D-13: an archived dricket ticket', () => {
    it('stays listed under Done this week and readable with its comments', async () => {
      const move = async (from: string, to: string): Promise<void> => {
        expect(await service.transition({ id: 'T-0003', from, to })).toMatchObject({ ok: true });
      };
      await move('inbox', 'build');
      await move('build', 'commit');
      await move('commit', 'done');
      dk(['comment', 't-3', '-m', 'Worked for me.']);
      expect(await service.archive({ id: 'T-0003' })).toMatchObject({ ok: true });

      const board = await service.snapshot();
      expect(board.columns.flatMap((c) => c.tickets).map((t) => t.id)).not.toContain('T-0003');
      expect(board.recentDone).toMatchObject([{ id: 'T-0003', title: 'Rename a folder' }]);

      const read = await service.readTicket('T-0003');
      expect(read).toMatchObject({ ok: true, card: { id: 'T-0003', phase: 'archive' } });
      expect(read.ok && read.card.meta.title).toBe('Rename a folder');
      expect(read.ok && read.comments?.map((c) => c.text)).toEqual(['Worked for me.']);
    });

    it('stays listed when it reached Done from a terminal, the way the sweep seeded it', async () => {
      dk(['add', '--prefix', 't', '-m', 'Seeded from a terminal', '--unclaimed']);
      execFileSync(bin, ['claim', 't-4', '--size', 'S', '--kind', 'human'], { windowsHide: true, stdio: 'pipe', env: { ...process.env, DK_OWNER: 'seed-agent@scratch' } });
      execFileSync(bin, ['release', 't-4', '--stage', 'done', '-m', 'Seeded into done.'], { windowsHide: true, stdio: 'pipe', env: { ...process.env, DK_OWNER: 'seed-agent@scratch' } });
      expect(await service.archive({ id: 'T-0004' })).toMatchObject({ ok: true });
      const shown = (JSON.parse(dk(['show', 't-4', '--json'])) as { data: { content: string } }).data.content;
      expect(shown).toContain('archived');
      const board = await service.snapshot();
      expect(board.recentDone.map((d) => d.id)).toContain('T-0004');
    });
  });
});
