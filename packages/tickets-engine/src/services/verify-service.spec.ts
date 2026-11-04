import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepoRef, TicketCard } from '../contracts/tickets';
import type { VerifyRunInput, VerifyRunResult } from '../contracts/verify';
import type { LedgerWrite } from '../core/ledger';
import { renderVerificationSection } from '../core/verification';
import type { TicketsGit } from '../core/tickets-git';
import type { EngineBoardService } from './board-service';
import type { EngineHost } from './host';
import { VerifyService } from './verify-service';
import { VideoService } from './video-service';

/**
 * The verify service (E4): a machine run persists the Verification
 * section and the screenshots as one commit and moves the ticket; a
 * refused or crashed run logs one line and leaves the ticket put. Fakes
 * for the board/host/harness/git — the worktree resolution alone touches
 * the real temp folder.
 */

const ACTOR = 'verify@tester';
const TICKET_ID = 'T-0102';
const TICKET_PATH = `tickets/inbox/${TICKET_ID}.md`;

const TICKET_TEXT = `---
id: ${TICKET_ID}
title: "The ticket"
repo: demo
---

## Description

The body.

## Plan

### Acceptance criteria

- [x] \`npm run build\`
- [ ] \`npm test\`

## Log

- '2026-11-01T13:00:00Z' owner@desk — created in inbox
`;

const REPO: RepoRef = {
  name: 'demo',
  url: 'https://example.com/demo.git',
  branch: 'main',
  policy: null,
  path: null,
  worker: null,
  worktrees: null,
  launch: 'npm start',
  instructions: null,
};

const OK_RESULT: VerifyRunResult = {
  environment: 'Electron 34.2.0 on win32',
  shots: [{ file: 'verify-01.png', criterion: 'npm run build' }],
  findings: ['The settings page stayed blank until the reload.'],
  video: null,
  error: null,
};

function makeCard(patch: { id?: string; path?: string; phase?: string; meta?: unknown } = {}): TicketCard {
  return {
    id: TICKET_ID,
    path: TICKET_PATH,
    phase: 'inbox',
    meta: { repo: 'demo' },
    ...patch,
  } as unknown as TicketCard;
}

function makeSnapshot(cards: readonly TicketCard[], phaseIds: readonly string[], repos: readonly RepoRef[] = [REPO]): FakeSnapshot {
  return {
    vaultId: 'vault',
    repos,
    columns: phaseIds.map((id) => ({
      phase: { id },
      tickets: cards.filter((c) => c.phase === id),
      unknown: false,
    })),
  };
}

interface FakeSnapshot {
  vaultId: string;
  repos: readonly RepoRef[];
  columns: { phase: { id: string }; tickets: TicketCard[]; unknown: boolean }[];
}

let root: string;
let vaultPath: string;
let files: Map<string, string>;
let announced: string[];
let commits: { root: string; paths: string[]; message: string }[];
let harnessRuns: VerifyRunInput[];
let harnessResult: VerifyRunResult;
let harnessGate: ((input: VerifyRunInput) => Promise<VerifyRunResult>) | null;
let card: TicketCard;
let boardListeners: (() => void)[];
let boardTransitions: unknown[];
let boardSnapshot: FakeSnapshot;
let ledgerWrites: LedgerWrite[];
let service: VerifyService;

async function waitFor(cond: () => boolean, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(cond()).toBe(true);
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(tmpdir(), 'verify-service-'));
  vaultPath = path.join(root, 'vault');
  await fsp.mkdir(path.join(vaultPath, 'tickets', 'attachments'), { recursive: true });
  await fsp.mkdir(path.join(vaultPath, '_worktrees', TICKET_ID), { recursive: true });
  files = new Map([[TICKET_PATH, TICKET_TEXT]]);
  announced = [];
  commits = [];
  harnessRuns = [];
  harnessResult = OK_RESULT;
  harnessGate = null;
  card = makeCard();
  boardListeners = [];
  boardTransitions = [];
  ledgerWrites = [];
  boardSnapshot = makeSnapshot([card], ['inbox', 'verify', 'needs-owner']);
});

afterEach(async () => {
  service?.dispose();
  await fsp.rm(root, { recursive: true, force: true });
});

interface BootOptions {
  phase?: string;
  videos?: VideoService;
}

function boot(opts: BootOptions = {}): VerifyService {
  const configData: Record<string, unknown> = opts.phase === undefined ? {} : { 'verify.phase': opts.phase };
  const config = {
    get: async <T,>(key: string): Promise<T | undefined> => configData[key] as T | undefined,
  };
  const board = {
    snapshot: async () => boardSnapshot,
    readTicket: async (id: string) => {
      const found = boardSnapshot.columns.flatMap((c) => c.tickets).find((t) => t.id === id) ?? null;
      const text = found === null ? undefined : files.get(found.path);
      return text === undefined ? { ok: false, error: `${id} is not on the board` } : { ok: true, card: found, text };
    },
    onChanged: (listener: () => void) => {
      boardListeners.push(listener);
      return () => undefined;
    },
    transition: async (input: unknown) => {
      boardTransitions.push(input);
      return { ok: true };
    },
  } as unknown as EngineBoardService;
  const host = {
    listVaults: async () => [{ id: 'vault', name: 'vault', path: vaultPath, exists: true, active: true }],
    read: async (_vault: string, p: string) => {
      const text = files.get(p);
      if (text === undefined) {
        throw new Error(`no such file: ${p}`);
      }
      return text;
    },
    write: async (_vault: string, p: string, text: string) => {
      files.set(p, text);
    },
    resolveAssetPath: (_vault: string, p: string) => path.join(vaultPath, p),
    announceChanges: (_vault: string, paths: readonly string[]) => {
      announced.push(...paths);
    },
  } as unknown as EngineHost;
  const harness = {
    run: async (input: VerifyRunInput) => {
      harnessRuns.push(input);
      return harnessGate === null ? harnessResult : harnessGate(input);
    },
  };
  const git = {
    locate: async (p: string) => ({ root: p, prefix: '' }),
    commitPaths: async (rootDir: string, paths: readonly string[], message: string) => {
      commits.push({ root: rootDir, paths: [...paths], message });
    },
  } as unknown as TicketsGit;
  return new VerifyService({
    board,
    host,
    harness,
    config,
    git,
    actor: ACTOR,
    log: () => undefined,
    events: { ledger: (write) => ledgerWrites.push(write) },
    ...(opts.videos === undefined ? {} : { videos: opts.videos }),
  });
}

describe('VerifyService.verifyTicket', () => {
  it('runs the harness, persists the section as one commit and moves the ticket', async () => {
    service = boot();

    const outcome = await service.verifyTicket({ id: TICKET_ID });

    expect(outcome).toEqual({ ok: true });
    expect(harnessRuns).toHaveLength(1);
    expect(harnessRuns[0]).toMatchObject({
      worktree: path.join(vaultPath, '_worktrees', TICKET_ID),
      command: 'npm start',
      criteria: ['npm run build', 'npm test'],
      judge: null,
    });
    expect(harnessRuns[0]!.attachDir).toBe(path.join(vaultPath, 'tickets', 'attachments'));

    const text = files.get(TICKET_PATH)!;
    expect(text).toContain('## Verification');
    expect(text).toMatch(new RegExp(`Tested on \\S+ by ${ACTOR} — Electron 34\\.2\\.0 on win32\\.`));
    expect(text).toContain('- [x] `npm run build` → ![](../attachments/verify-01.png)');
    expect(text).toContain('- [ ] `npm test` — no screenshot');
    expect(text).toContain('- The settings page stayed blank until the reload.');
    expect(text).toContain(`verified — 1/2 criteria green`);

    expect(commits).toEqual([
      {
        root: vaultPath,
        paths: [TICKET_PATH, 'tickets/attachments/verify-01.png'],
        message: `tickets: ${TICKET_ID} verified`,
      },
    ]);
    expect(announced).toEqual([TICKET_PATH, 'tickets/attachments/verify-01.png']);
    expect(boardTransitions).toEqual([{ id: TICKET_ID, from: 'inbox', to: 'verify', actor: ACTOR }]);

    expect(service.status({ id: TICKET_ID })).toEqual({
      ticket: TICKET_ID,
      state: 'done',
      error: null,
      report: {
        testedAt: expect.any(String),
        tester: ACTOR,
        environment: 'Electron 34.2.0 on win32',
        criteria: [
          { command: 'npm run build', passed: true, screenshot: 'verify-01.png', note: null },
          { command: 'npm test', passed: false, screenshot: null, note: 'no screenshot' },
        ],
        findings: ['The settings page stayed blank until the reload.'],
      },
    });
  });

  it('records the walkthrough video and its chapters for a ui proof (E11-1)', async () => {
    harnessResult = {
      ...OK_RESULT,
      shots: [{ file: 'verify-01.png', criterion: 'npm run build', atMs: 12_000 }],
      video: 'verify-20261101-143200-T-0102.webm',
    };
    service = boot();

    await service.verifyTicket({ id: TICKET_ID });

    expect(harnessRuns[0]).toMatchObject({ ticket: TICKET_ID, proof: 'ui' });
    const text = files.get(TICKET_PATH)!;
    expect(text).toContain('### Video\n\n![](../videos/verify-20261101-143200-T-0102.webm)\n\n- 0:12 npm run build');
  });

  describe('the per-video cap (E11-1c)', () => {
    const MB = 1024 * 1024;
    const NAME = 'verify-20261101-143200-T-0102.webm';

    function videoService(maxMb?: number): VideoService {
      return new VideoService({
        board: { detect: async () => ({ id: 'vault', name: 'vault', path: vaultPath, exists: true, active: true }) } as unknown as EngineBoardService,
        host: {
          listVaults: async () => [{ id: 'vault', name: 'vault', path: vaultPath, exists: true, active: true }],
          resolveAssetPath: (_v: string, p: string) => path.join(vaultPath, p),
        } as unknown as EngineHost,
        git: {} as unknown as TicketsGit,
        config: { get: async <T,>(k: string) => (k === 'videos.maxMb' ? (maxMb as T | undefined) : undefined) },
      });
    }

    async function runWith(bytes: number, maxMb?: number): Promise<string> {
      await fsp.mkdir(path.join(vaultPath, 'tickets', 'videos'), { recursive: true });
      await fsp.writeFile(path.join(vaultPath, 'tickets', 'videos', 'verify-old-T-0001.webm'), Buffer.alloc(30 * MB));
      harnessResult = { ...OK_RESULT, shots: [{ file: 'verify-01.png', criterion: 'npm run build', atMs: 12_000 }], video: NAME };
      harnessGate = async (input) => {
        await fsp.writeFile(path.join(input.videoDir, NAME), Buffer.alloc(bytes));
        return harnessResult;
      };
      service = boot({ videos: videoService(maxMb) });
      expect(await service.verifyTicket({ id: TICKET_ID })).toEqual({ ok: true });
      return files.get(TICKET_PATH)!;
    }

    const exists = (name: string): Promise<boolean> =>
      fsp.stat(path.join(vaultPath, 'tickets', 'videos', name)).then(() => true, () => false);

    it('keeps a recording of exactly 25 MB with its player and chapters', async () => {
      const text = await runWith(25 * MB);
      expect(text).toContain(`### Video\n\n![](../videos/${NAME})`);
      expect(text).not.toContain('Video not kept');
      expect(await exists(NAME)).toBe(true);
    });

    it('drops a recording over the cap and writes one honest line instead of the player', async () => {
      const text = await runWith(31 * MB);
      expect(text).toContain('### Video\n\nVideo not kept: 31 MB exceeds the 25 MB limit.\n');
      expect(text).not.toContain('![](../videos/');
      expect(text).toContain('![](../attachments/verify-01.png)');
      expect(await exists(NAME)).toBe(false);
      // Nothing else is ever deleted: the older, larger video stays.
      expect(await exists('verify-old-T-0001.webm')).toBe(true);
    });

    it('follows videos.maxMb', async () => {
      const text = await runWith(3 * MB, 2);
      expect(text).toContain('Video not kept: 3 MB exceeds the 2 MB limit.');
    });
  });

  it('asks the harness for a tests proof when the Handover declares one, and records no shots', async () => {
    files.set(TICKET_PATH, TICKET_TEXT.replace('## Log', '## Handover\n\nproof: tests — a parser change\n\n## Log'));
    harnessResult = { ...OK_RESULT, shots: [], video: null, environment: 'tests only — no app started' };
    service = boot();

    await service.verifyTicket({ id: TICKET_ID });

    expect(harnessRuns[0]).toMatchObject({ proof: 'tests' });
    const text = files.get(TICKET_PATH)!;
    expect(text).toContain('- [x] `npm run build` — checked by the machine gate');
    expect(text).not.toContain('![](');
    expect(text).not.toContain('### Video');
  });

  it('lets the ticket pin beat the Handover declaration (E11-1)', async () => {
    files.set(TICKET_PATH, TICKET_TEXT.replace('## Log', '## Handover\n\nproof: tests — x\n\n## Log'));
    card = makeCard({ meta: { repo: 'demo', proof: 'ui' } });
    boardSnapshot = makeSnapshot([card], ['inbox', 'verify', 'needs-owner']);
    service = boot();

    await service.verifyTicket({ id: TICKET_ID });

    expect(harnessRuns[0]).toMatchObject({ proof: 'ui' });
  });

  it('writes the ledger proof_ready line after the persisted proof (E7)', async () => {
    service = boot();

    const outcome = await service.verifyTicket({ id: TICKET_ID });

    expect(outcome).toEqual({ ok: true });
    expect(ledgerWrites).toEqual([{ kind: 'proof_ready', ticket: TICKET_ID, persona: null, model: null }]);
  });

  it('writes no ledger line when the run refuses before any proof exists', async () => {
    harnessResult = { ...OK_RESULT, error: 'the app never came up' };
    service = boot();

    const outcome = await service.verifyTicket({ id: TICKET_ID });

    expect(outcome.ok).toBe(false);
    expect(ledgerWrites).toEqual([]);
  });

  it('runs from any phase — a manual trigger does not need the verify phase', async () => {
    service = boot();

    await service.verifyTicket({ id: TICKET_ID });

    expect(boardTransitions).toEqual([{ id: TICKET_ID, from: 'inbox', to: 'verify', actor: ACTOR }]);
  });

  it('stays put after a successful run when no next phase exists', async () => {
    card = makeCard({ phase: 'needs-owner', path: `tickets/needs-owner/${TICKET_ID}.md` });
    files.set(card.path, TICKET_TEXT);
    files.delete(TICKET_PATH);
    boardSnapshot = makeSnapshot([card], ['inbox', 'verify', 'needs-owner']);
    service = boot();

    const outcome = await service.verifyTicket({ id: TICKET_ID });

    expect(outcome).toEqual({ ok: true });
    expect(boardTransitions).toEqual([]);
    expect(service.status({ id: TICKET_ID }).state).toBe('done');
  });

  it('refuses cleanly when the ticket has no worktree — log line, no section, no run', async () => {
    await fsp.rm(path.join(vaultPath, '_worktrees', TICKET_ID), { recursive: true, force: true });
    service = boot();

    const outcome = await service.verifyTicket({ id: TICKET_ID });

    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ ok: false, error: `verify refused — ${TICKET_ID} has no worktree yet — nothing to verify` });
    expect(harnessRuns).toEqual([]);
    const text = files.get(TICKET_PATH)!;
    expect(text).not.toContain('## Verification');
    expect(text).toContain(`verify refused — ${TICKET_ID} has no worktree yet — nothing to verify`);
    expect(commits).toEqual([{ root: vaultPath, paths: [TICKET_PATH], message: `tickets: ${TICKET_ID} verify failed` }]);
    expect(boardTransitions).toEqual([]);
    expect(service.status({ id: TICKET_ID })).toMatchObject({ state: 'failed' });
  });

  it('refuses when the ticket names no repo or a repo the board does not know', async () => {
    card = makeCard({ meta: { repo: null } });
    boardSnapshot = makeSnapshot([card], ['inbox', 'verify', 'needs-owner']);
    service = boot();
    const noRepo = await service.verifyTicket({ id: TICKET_ID });
    expect(noRepo.ok).toBe(false);
    expect(files.get(TICKET_PATH)!).toContain(`verify refused — ${TICKET_ID} names no work repo — nothing to verify`);

    card = makeCard({ meta: { repo: 'ghost' } });
    boardSnapshot = makeSnapshot([card], ['inbox', 'verify', 'needs-owner']);
    service.dispose();
    service = boot();
    const ghost = await service.verifyTicket({ id: TICKET_ID });
    expect(ghost.ok).toBe(false);
    expect(files.get(TICKET_PATH)!).toContain(`verify refused — ${TICKET_ID} names no work repo — nothing to verify`);
    expect(harnessRuns).toEqual([]);
  });

  it('refuses when the repo names no launch command and the worktree has no dev.ps1', async () => {
    boardSnapshot = makeSnapshot([card], ['inbox', 'verify', 'needs-owner'], [{ ...REPO, launch: null }]);
    service = boot();

    const outcome = await service.verifyTicket({ id: TICKET_ID });

    expect(outcome.ok).toBe(false);
    expect(harnessRuns).toEqual([]);
    expect(files.get(TICKET_PATH)!).toContain('no launch command');
    expect(files.get(TICKET_PATH)!).not.toContain('## Verification');
  });

  it('falls back to the dev.ps1 -Built -Multi launch convention', async () => {
    boardSnapshot = makeSnapshot([card], ['inbox', 'verify', 'needs-owner'], [{ ...REPO, launch: null }]);
    await fsp.writeFile(path.join(vaultPath, '_worktrees', TICKET_ID, 'dev.ps1'), '# launch\n', 'utf8');
    service = boot();

    const outcome = await service.verifyTicket({ id: TICKET_ID });

    expect(outcome).toEqual({ ok: true });
    expect(harnessRuns[0]!.command).toBe('powershell -NoProfile -ExecutionPolicy Bypass -File dev.ps1 -Built -Multi');
  });

  it('a harness error logs one line, fails the status and leaves the ticket', async () => {
    harnessResult = { ...OK_RESULT, error: 'the app never became ready', shots: [], findings: [] };
    service = boot();

    const outcome = await service.verifyTicket({ id: TICKET_ID });

    expect(outcome).toMatchObject({ ok: false, error: 'verify failed — the app never became ready' });
    const text = files.get(TICKET_PATH)!;
    expect(text).toContain('verify failed — the app never became ready');
    expect(text).not.toContain('## Verification');
    expect(commits).toEqual([{ root: vaultPath, paths: [TICKET_PATH], message: `tickets: ${TICKET_ID} verify failed` }]);
    expect(boardTransitions).toEqual([]);
    expect(service.status({ id: TICKET_ID })).toMatchObject({ state: 'failed', error: 'verify failed — the app never became ready' });
  });

  it('runs one at a time per ticket', async () => {
    let release: ((result: VerifyRunResult) => void) | null = null;
    harnessGate = () => new Promise<VerifyRunResult>((resolve) => {
      release = resolve;
    });
    service = boot();

    const first = service.verifyTicket({ id: TICKET_ID });
    await waitFor(() => release !== null);
    const second = await service.verifyTicket({ id: TICKET_ID });
    expect(second).toEqual({ ok: false, error: `${TICKET_ID} already has a verify run in flight` });

    release!(OK_RESULT);
    await expect(first).resolves.toEqual({ ok: true });
  });

  it('reports idle for a ticket no run ever touched', async () => {
    service = boot();
    expect(service.status({ id: 'T-9999' })).toEqual({ ticket: 'T-9999', state: 'idle', report: null, error: null });
  });
});

describe('VerifyService auto-scan', () => {
  it('runs candidates in the verify phase only — and skips cards already verified', async () => {
    const verified = makeCard({ id: 'T-0200', path: 'tickets/verify/T-0200.md', phase: 'verify' });
    files.set(
      verified.path,
      `${TICKET_TEXT}\n${renderVerificationSection({
        testedAt: '2026-11-01T10:00:00Z',
        tester: ACTOR,
        environment: 'Electron 34.2.0 on win32',
        criteria: [{ command: 'npm run build', passed: true, screenshot: 'verify-01.png', note: null }],
        findings: [],
      })}`,
    );
    const elsewhere = makeCard({ id: 'T-0300', path: 'tickets/inbox/T-0300.md', phase: 'inbox' });
    files.set(elsewhere.path, TICKET_TEXT);
    // The candidate moves into the verify phase only after the boot scan —
    // so the debounced board-change listener is what picks it up.
    boardSnapshot = makeSnapshot([verified, elsewhere], ['inbox', 'verify', 'needs-owner']);
    service = boot();
    await service.initialScan;
    expect(harnessRuns).toEqual([]);

    card = makeCard({ phase: 'verify', path: `tickets/verify/${TICKET_ID}.md` });
    files.set(card.path, TICKET_TEXT);
    files.delete(TICKET_PATH);
    boardSnapshot = makeSnapshot([card, verified, elsewhere], ['inbox', 'verify', 'needs-owner']);

    boardListeners.forEach((listener) => listener());
    await waitFor(() => boardTransitions.length === 1);

    expect(harnessRuns).toHaveLength(1);
    expect(harnessRuns[0]!.criteria).toEqual(['npm run build', 'npm test']);
    expect(service.status({ id: TICKET_ID }).state).toBe('done');
    expect(service.status({ id: 'T-0200' }).state).toBe('idle');
    expect(service.status({ id: 'T-0300' }).state).toBe('idle');
    expect(boardTransitions).toEqual([{ id: TICKET_ID, from: 'verify', to: 'needs-owner', actor: ACTOR }]);
  });

  it('honours the verify.phase config key for the candidate phase', async () => {
    card = makeCard({ phase: 'staging', path: `tickets/staging/${TICKET_ID}.md` });
    files.set(card.path, TICKET_TEXT);
    files.delete(TICKET_PATH);
    boardSnapshot = makeSnapshot([card], ['inbox', 'staging', 'needs-owner']);
    service = boot({ phase: 'staging' });

    boardListeners.forEach((listener) => listener());
    await waitFor(() => service.status({ id: TICKET_ID }).state === 'done');

    expect(harnessRuns).toHaveLength(1);
  });

  it('stops scanning after dispose', async () => {
    service = boot();
    service.dispose();

    boardListeners.forEach((listener) => listener());
    await new Promise((resolve) => setTimeout(resolve, 1_300));

    expect(harnessRuns).toEqual([]);
  });
});
