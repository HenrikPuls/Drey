/**
 * E4: the Playwright verify harness — the pure shot-planning and exe
 * discovery for real, the run loop against a fake driver that writes fake
 * PNG bytes into a real temp attachments dir. No browser, no network.
 */
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_VERIFY_SHOTS, type VerifyJudge, type VerifyRunInput } from '../contracts/verify';
import {
  createPlaywrightVerifyHarness,
  findElectronExe,
  formatVerifyStamp,
  planVerifyShots,
  type VerifyDriver,
  type VerifyDriverApp,
  type VerifyDriverLaunch,
  type VerifyExeFs,
  type VerifyRunOutcome,
} from './verify-harness';

describe('formatVerifyStamp', () => {
  it('renders the compact UTC stamp the shot files carry', () => {
    expect(formatVerifyStamp(new Date(Date.UTC(2026, 10, 1, 14, 32, 0)))).toBe('20261101-143200');
  });
});

describe('planVerifyShots', () => {
  it('pairs criteria in order to sequential shot file names', () => {
    const plan = planVerifyShots(['npm run build', 'npm test'], '20261101-143200');
    expect(plan.shots).toEqual([
      { file: 'verify-20261101-143200-01.png', criterion: 'npm run build' },
      { file: 'verify-20261101-143200-02.png', criterion: 'npm test' },
    ]);
    expect(plan.capped).toEqual([]);
  });

  it('caps at MAX_VERIFY_SHOTS and reports the rest as capped', () => {
    const criteria = Array.from({ length: MAX_VERIFY_SHOTS + 2 }, (_, i) => `check ${i + 1}`);
    const plan = planVerifyShots(criteria, 's');
    expect(plan.shots).toHaveLength(MAX_VERIFY_SHOTS);
    expect(plan.shots.map((s) => s.file)).toEqual(
      Array.from({ length: MAX_VERIFY_SHOTS }, (_, i) => `verify-s-${String(i + 1).padStart(2, '0')}.png`),
    );
    expect(plan.capped).toEqual(['check 7', 'check 8']);
  });

  it('plans no shots for no criteria', () => {
    expect(planVerifyShots([], 's')).toEqual({ shots: [], capped: [] });
  });
});

describe('findElectronExe', () => {
  const fsOf = (dirs: Record<string, readonly string[]>, mtimes: Record<string, number>): VerifyExeFs => ({
    readdir: async (dir) => {
      const entries = dirs[path.normalize(dir)];
      if (entries === undefined) {
        throw new Error(`ENOENT: ${dir}`);
      }
      return entries;
    },
    stat: async (file) => {
      const mtimeMs = mtimes[path.normalize(file)];
      return mtimeMs === undefined ? null : { mtimeMs };
    },
  });

  it('picks the newest exe across win-unpacked and one level of release/', async () => {
    const worktree = path.join('C', 'wt');
    const release = path.join(worktree, 'release');
    const fs = fsOf(
      {
        [path.normalize(path.join(release, 'win-unpacked'))]: ['drey.exe', 'drey-0.5.0-setup.exe'],
        [path.normalize(release)]: ['drey-0.6.0-setup.exe', 'win-unpacked'],
      },
      {
        [path.normalize(path.join(release, 'win-unpacked', 'drey.exe'))]: 100,
        // The installer would be newer — it is skipped by name, not mtime.
        [path.normalize(path.join(release, 'win-unpacked', 'drey-0.5.0-setup.exe'))]: 900,
        [path.normalize(path.join(release, 'drey-0.6.0-setup.exe'))]: 1000,
      },
    );
    expect(await findElectronExe(worktree, fs)).toBe(path.join(release, 'win-unpacked', 'drey.exe'));
  });

  it('skips installer names (setup, installer, unins) case-insensitively', async () => {
    const worktree = path.join('C', 'wt');
    const release = path.join(worktree, 'release');
    const fs = fsOf(
      {
        [path.normalize(release)]: ['app-SETUP.exe', 'Unins000.exe', 'My Installer.exe'],
        [path.normalize(path.join(release, 'win-unpacked'))]: [],
      },
      {},
    );
    expect(await findElectronExe(worktree, fs)).toBeNull();
  });

  it('falls back to a plain release/ exe when win-unpacked is absent', async () => {
    const worktree = path.join('C', 'wt');
    const release = path.join(worktree, 'release');
    const fs = fsOf(
      { [path.normalize(release)]: ['drey.exe'] },
      { [path.normalize(path.join(release, 'drey.exe'))]: 42 },
    );
    expect(await findElectronExe(worktree, fs)).toBe(path.join(release, 'drey.exe'));
  });

  it('returns null when no exe qualifies or release/ is missing entirely', async () => {
    const worktree = path.join('C', 'wt');
    const fs = fsOf({}, {});
    expect(await findElectronExe(worktree, fs)).toBeNull();
  });
});

/** The run-loop specs: a fake driver writes fake PNG bytes into attachDir. */
describe('createPlaywrightVerifyHarness (fake driver)', () => {
  let root: string;
  let worktree: string;
  let attachDir: string;
  let exeDir: string;

  const NOW = new Date(Date.UTC(2026, 10, 1, 14, 32, 0));

  interface FakeApp extends VerifyDriverApp {
    readonly launched: VerifyDriverLaunch;
    finishedWith: boolean | null;
  }

  interface FakeDriver extends VerifyDriver {
    readonly apps: FakeApp[];
    failLaunch: Error | null;
    failReady: Error | null;
    failShots: Set<string>;
  }

  function makeDriver(): FakeDriver {
    const driver: FakeDriver = {
      apps: [],
      failLaunch: null,
      failReady: null,
      failShots: new Set(),
      async launch(input) {
        if (driver.failLaunch !== null) {
          throw driver.failLaunch;
        }
        const app: FakeApp = {
          launched: input,
          finishedWith: null,
          environment: 'Electron 34.2.0 on win32',
          async firstWindow() {
            if (driver.failReady !== null) {
              throw driver.failReady; // a never-ready app
            }
          },
          async shot(file) {
            if (driver.failShots.has(file)) {
              throw new Error('the page refused the screenshot');
            }
            await fsp.writeFile(path.join(input.attachDir, file), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
          },
          async finish(keepVideo) {
            app.finishedWith = keepVideo;
            if (keepVideo) {
              await fsp.writeFile(path.join(input.attachDir, 'verify-run.webm'), Buffer.from('fake-video'));
              return { video: 'verify-run.webm' };
            }
            return { video: null };
          },
        };
        driver.apps.push(app);
        return app;
      },
    };
    return driver;
  }

  const input = (criteria: readonly string[], judge: VerifyJudge | null = null): VerifyRunInput => ({
    worktree,
    command: 'powershell -File dev.ps1 -Built -Multi',
    criteria,
    attachDir,
    judge,
  });

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'verify-harness-'));
    worktree = path.join(root, 'wt');
    exeDir = path.join(worktree, 'release', 'win-unpacked');
    attachDir = path.join(root, 'vault', 'tickets', 'attachments');
    await fsp.mkdir(exeDir, { recursive: true });
    await fsp.mkdir(attachDir, { recursive: true });
    await fsp.writeFile(path.join(exeDir, 'drey.exe'), Buffer.from([0]));
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('drives the built exe, captures one shot per criterion and passes without a judge', async () => {
    const driver = makeDriver();
    const harness = createPlaywrightVerifyHarness({ driver, now: () => NOW, settleMs: 0 });
    const result = (await harness.run(input(['npm run build', 'npm test']))) as VerifyRunOutcome;

    expect(result.error).toBeNull();
    expect(result.environment).toBe('Electron 34.2.0 on win32');
    expect(result.shots).toEqual([
      { file: 'verify-20261101-143200-01.png', criterion: 'npm run build' },
      { file: 'verify-20261101-143200-02.png', criterion: 'npm test' },
    ]);
    expect(result.verdicts).toEqual([
      { criterion: 'npm run build', passed: true, note: null },
      { criterion: 'npm test', passed: true, note: null },
    ]);
    for (const shot of result.shots) {
      const bytes = await fsp.readFile(path.join(attachDir, shot.file));
      expect([...bytes]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    }
    const app = driver.apps[0]!;
    expect(path.normalize(app.launched.exe)).toBe(path.normalize(path.join(exeDir, 'drey.exe')));
    expect(app.launched.command).toBe('powershell -File dev.ps1 -Built -Multi');
    expect(app.launched.attachDir).toBe(attachDir);
    // A green run discards the failure video.
    expect(app.finishedWith).toBe(false);
    expect(result.video).toBeNull();
    expect(result.findings).toEqual(['ready in 0.0 s — first window plus 0.0 s settle']);
  });

  it('lets the judge fail a shot and keeps the failure video for it', async () => {
    const driver = makeDriver();
    const seen: { criterion: string; screenshotPath: string }[] = [];
    const judge: VerifyJudge = {
      async judge({ criterion, screenshotPath }) {
        seen.push({ criterion, screenshotPath });
        return criterion === 'npm test' ? { passed: false, note: 'the settings page is blank' } : { passed: true, note: null };
      },
    };
    const harness = createPlaywrightVerifyHarness({ driver, now: () => NOW, settleMs: 0 });
    const result = (await harness.run(input(['npm run build', 'npm test'], judge))) as VerifyRunOutcome;

    expect(seen.map((s) => s.criterion)).toEqual(['npm run build', 'npm test']);
    expect(path.normalize(seen[0]!.screenshotPath)).toBe(
      path.normalize(path.join(attachDir, 'verify-20261101-143200-01.png')),
    );
    expect(result.error).toBeNull();
    expect(result.shots).toEqual([{ file: 'verify-20261101-143200-01.png', criterion: 'npm run build' }]);
    expect(result.verdicts).toEqual([
      { criterion: 'npm run build', passed: true, note: null },
      { criterion: 'npm test', passed: false, note: 'the settings page is blank' },
    ]);
    expect(result.findings).toContain('the judge failed on `npm test`: the settings page is blank');
    // The failure keeps the video.
    expect(driver.apps[0]!.finishedWith).toBe(true);
    expect(result.video).toBe('verify-run.webm');
    await expect(fsp.stat(path.join(attachDir, 'verify-run.webm'))).resolves.toBeDefined();
  });

  it('records a judge remark on a passing shot as a finding', async () => {
    const driver = makeDriver();
    const judge: VerifyJudge = {
      async judge() {
        return { passed: true, note: 'a reload flash at startup' };
      },
    };
    const harness = createPlaywrightVerifyHarness({ driver, now: () => NOW, settleMs: 0 });
    const result = (await harness.run(input(['npm run build'], judge))) as VerifyRunOutcome;

    expect(result.verdicts).toEqual([{ criterion: 'npm run build', passed: true, note: 'a reload flash at startup' }]);
    expect(result.findings).toContain('judge note on `npm run build`: a reload flash at startup');
    expect(result.video).toBeNull();
  });

  it('waits the settle delay after the first window and reports the readiness duration', async () => {
    const driver = makeDriver();
    const harness = createPlaywrightVerifyHarness({ driver, now: () => new Date(), settleMs: 1000 });
    const started = Date.now();
    const result = (await harness.run(input(['npm run build']))) as VerifyRunOutcome;

    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(result.error).toBeNull();
    expect(result.findings).toEqual([expect.stringMatching(/^ready in 1\.[0-9] s — first window plus 1\.0 s settle$/)]);
  });

  it('marks a failed screenshot as not passed without a judge', async () => {
    const driver = makeDriver();
    driver.failShots.add('verify-20261101-143200-02.png');
    const harness = createPlaywrightVerifyHarness({ driver, now: () => NOW, settleMs: 0 });
    const result = (await harness.run(input(['one', 'two']))) as VerifyRunOutcome;

    expect(result.error).toBeNull();
    expect(result.shots).toEqual([{ file: 'verify-20261101-143200-01.png', criterion: 'one' }]);
    expect(result.verdicts).toEqual([
      { criterion: 'one', passed: true, note: null },
      { criterion: 'two', passed: false, note: 'the page refused the screenshot' },
    ]);
    expect(result.findings).toContain('the screenshot failed on `two`: the page refused the screenshot');
    expect(driver.apps[0]!.finishedWith).toBe(true);
  });

  it('captures only MAX_VERIFY_SHOTS and verdicts the capped criteria as failed', async () => {
    const driver = makeDriver();
    const harness = createPlaywrightVerifyHarness({ driver, now: () => NOW, settleMs: 0 });
    const criteria = Array.from({ length: MAX_VERIFY_SHOTS + 2 }, (_, i) => `check ${i + 1}`);
    const result = (await harness.run(input(criteria))) as VerifyRunOutcome;

    expect(result.error).toBeNull();
    expect(result.shots).toHaveLength(MAX_VERIFY_SHOTS);
    expect(result.verdicts).toHaveLength(MAX_VERIFY_SHOTS + 2);
    expect(result.verdicts.slice(MAX_VERIFY_SHOTS)).toEqual([
      { criterion: 'check 7', passed: false, note: `no screenshot: past the ${MAX_VERIFY_SHOTS}-shot cap` },
      { criterion: 'check 8', passed: false, note: `no screenshot: past the ${MAX_VERIFY_SHOTS}-shot cap` },
    ]);
    expect(result.findings).toContain('no screenshot past the 6-shot cap: `check 7`, `check 8`');
    // No judge ran: the captured six pass, so the video still goes.
    expect(driver.apps[0]!.finishedWith).toBe(false);
  });

  it('refuses with an error when no built exe exists', async () => {
    const driver = makeDriver();
    await fsp.rm(path.join(worktree, 'release'), { recursive: true, force: true });
    const harness = createPlaywrightVerifyHarness({ driver, now: () => NOW, settleMs: 0 });
    const result = (await harness.run(input(['npm run build']))) as VerifyRunOutcome;

    expect(result.error).toContain('no built app exe under');
    expect(result.shots).toEqual([]);
    expect(result.verdicts).toEqual([]);
    expect(driver.apps).toHaveLength(0); // never launched
  });

  it('refuses with the launch failure when the driver rejects', async () => {
    const driver = makeDriver();
    driver.failLaunch = new Error('playwright is not installed');
    const harness = createPlaywrightVerifyHarness({ driver, now: () => NOW, settleMs: 0 });
    const result = (await harness.run(input(['npm run build']))) as VerifyRunOutcome;

    expect(result.error).toBe('playwright is not installed');
    expect(result.shots).toEqual([]);
    expect(result.verdicts).toEqual([]);
  });

  it('errors as never-ready when the first window never comes, keeping the video', async () => {
    const driver = makeDriver();
    driver.failReady = new Error('the app stayed on the splash screen');
    const harness = createPlaywrightVerifyHarness({ driver, now: () => NOW, settleMs: 0 });
    const result = (await harness.run(input(['npm run build']))) as VerifyRunOutcome;

    expect(result.error).toBe('the app never became ready: the app stayed on the splash screen');
    expect(result.shots).toEqual([]);
    expect(result.verdicts).toEqual([]);
    expect(result.environment).toBe('Electron 34.2.0 on win32');
    expect(result.findings).toContain('never became ready: the app stayed on the splash screen');
    // A dead run still owns its recording.
    expect(driver.apps[0]!.finishedWith).toBe(true);
    expect(result.video).toBe('verify-run.webm');
  });
});
