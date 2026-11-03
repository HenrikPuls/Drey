/**
 * The Playwright verify harness (E4): a machine step, not an agent run —
 * it drives the ticket worktree's built Electron app along the acceptance
 * criteria, captures one proof screenshot per criterion into the vault's
 * `tickets/attachments/` folder and reports what happened. The run loop
 * sits behind a driver seam: production lazy-imports `playwright` and
 * launches the built exe with `_electron.launch`, specs inject a fake
 * driver (no browser, no network). The harness never commits and never
 * touches the ticket file — the verify service persists the report.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import {
  MAX_VERIFY_SHOTS,
  type VerifyHarness,
  type VerifyRunInput,
  type VerifyRunResult,
  type VerifyShot,
} from '../contracts/verify';

/** Settle delay after the app's first window, in ms (the default). */
const DEFAULT_SETTLE_MS = 10_000;
/** How long the real driver waits for the first window before giving up. */
const FIRST_WINDOW_TIMEOUT_MS = 60_000;
/** Installer-ish exe names never count as the built app. */
const INSTALLER_NAME = /setup|installer|unins/i;
/** The shot files' prefix; `img-…` belongs to the phone. */
const SHOT_PREFIX = 'verify-';

// ---------------------------------------------------------------------------
// The pure core: which criteria get which shot file.

export interface VerifyShotPlan {
  /** One shot per paired criterion, in order. */
  readonly shots: readonly VerifyShot[];
  /** Criteria past MAX_VERIFY_SHOTS — the caller turns them into a finding. */
  readonly capped: readonly string[];
}

/** The compact UTC stamp shot files carry — `YYYYMMDD-HHMMSS`. */
export function formatVerifyStamp(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`
  );
}

/**
 * Pairs the acceptance criteria, in order, to sequential shot file names
 * `verify-<stamp>-<nn>.png`. Only the first MAX_VERIFY_SHOTS criteria get
 * a shot — beyond the cap the owner stops looking at the proof card, and
 * the run reports the rest as capped instead of silently dropping them.
 */
export function planVerifyShots(criteria: readonly string[], stamp: string): VerifyShotPlan {
  const shots: VerifyShot[] = criteria.slice(0, MAX_VERIFY_SHOTS).map((criterion, index) => ({
    file: `${SHOT_PREFIX}${stamp}-${String(index + 1).padStart(2, '0')}.png`,
    criterion,
  }));
  return { shots, capped: criteria.slice(MAX_VERIFY_SHOTS) };
}

// ---------------------------------------------------------------------------
// The built-app exe: `release/win-unpacked/` and one level of `release/`.

/** The readdir/stat seam `findElectronExe` scans through. */
export interface VerifyExeFs {
  /** Directory entries; rejects when the directory is unreadable. */
  readdir(dir: string): Promise<readonly string[]>;
  /** File mtime; null when the file cannot be stated (vanished, not a file). */
  stat(file: string): Promise<{ mtimeMs: number } | null>;
}

const defaultVerifyExeFs: VerifyExeFs = {
  readdir: async (dir) => fsp.readdir(dir),
  stat: async (file) =>
    fsp
      .stat(file)
      .then((s) => ({ mtimeMs: s.mtimeMs }))
      .catch(() => null),
};

/**
 * Locates the worktree's built app exe: every `.exe` directly in
 * `release/win-unpacked/` and one level of `release/`, the installer
 * names (`setup`, `installer`, `unins…`) skipped, the newest mtime
 * winning. Null when nothing qualifies — the run refuses with a finding
 * instead of launching an installer.
 */
export async function findElectronExe(worktree: string, fs: VerifyExeFs = defaultVerifyExeFs): Promise<string | null> {
  const releaseDir = path.join(worktree, 'release');
  const dirs = [path.join(releaseDir, 'win-unpacked'), releaseDir];
  let best: { file: string; mtimeMs: number } | null = null;
  for (const dir of dirs) {
    let entries: readonly string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue; // the folder simply is not there
    }
    for (const name of entries) {
      if (!name.toLowerCase().endsWith('.exe') || INSTALLER_NAME.test(name)) {
        continue;
      }
      const file = path.join(dir, name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat === null) {
        continue;
      }
      if (best === null || stat.mtimeMs > best.mtimeMs) {
        best = { file, mtimeMs: stat.mtimeMs };
      }
    }
  }
  return best?.file ?? null;
}

// ---------------------------------------------------------------------------
// The driver seam — specs inject a fake; production lazy-imports playwright.

/** What the harness hands a driver for one run. */
export interface VerifyDriverLaunch {
  readonly worktree: string;
  readonly exe: string;
  /** The repo's `launch:` from repos.md — the driver's documentation and
   *  its shell fallback; null = the Electron default. */
  readonly command: string | null;
  /** Where the screenshots go. */
  readonly attachDir: string;
  /** Where the walkthrough video goes, and the name it ends up with. */
  readonly videoDir: string;
  readonly videoName: string;
}

/** The launched app behind the seam. */
export interface VerifyDriverApp {
  /** One line, best effort: `Electron 34.2.0 on win32`. */
  readonly environment: string;
  /** Resolves once the app's first window exists; rejects when the app
   *  died or never became ready. */
  firstWindow(): Promise<void>;
  /** Captures one screenshot into `<attachDir>/<file>`. */
  shot(file: string): Promise<void>;
  /** Closes the app; keeps the walkthrough video as `videoName` in
   *  `videoDir` when asked, deletes it otherwise. Returns the kept
   *  video's file name. */
  finish(keepVideo: boolean): Promise<{ video: string | null }>;
}

export interface VerifyDriver {
  launch(input: VerifyDriverLaunch): Promise<VerifyDriverApp>;
}

/** The Playwright Electron slice this driver touches — local and minimal
 *  on purpose: playwright may not be installed, and the boundary stays
 *  `unknown` so a missing or differently-shaped build degrades, never
 *  breaks the compile. */
interface PlaywrightModule {
  readonly _electron: {
    launch(options: Record<string, unknown>): Promise<unknown>;
  };
}

interface PlaywrightElectronHandle {
  version(): Promise<string>;
  firstWindow(): Promise<PlaywrightPageHandle>;
  close(): Promise<void>;
  context(): { pages(): PlaywrightPageHandle[] };
}

interface PlaywrightPageHandle {
  screenshot(options: { path: string }): Promise<unknown>;
  video(): { path(): Promise<string> } | null;
}

async function loadPlaywright(): Promise<PlaywrightModule> {
  let loaded: unknown;
  try {
    loaded = await import('playwright');
  } catch (error) {
    throw new Error(`playwright is not installed — the verify harness cannot drive the built app: ${messageOf(error)}`);
  }
  const module = loaded as Partial<PlaywrightModule>;
  if (typeof module._electron?.launch !== 'function') {
    throw new Error('the installed playwright exposes no _electron.launch — the Electron driver is unavailable');
  }
  return module as PlaywrightModule;
}

async function electronEnvironment(app: Partial<PlaywrightElectronHandle>): Promise<string> {
  let version = '';
  if (typeof app.version === 'function') {
    try {
      const raw = await app.version();
      version = typeof raw === 'string' ? raw.trim() : '';
    } catch {
      version = '';
    }
  }
  return version === '' ? `Electron on ${process.platform}` : `Electron ${version} on ${process.platform}`;
}

async function withTimeout(promise: Promise<void>, ms: number, message: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The real driver: lazy-imports playwright (it may be absent) and drives
 *  the built exe through `_electron.launch`, video recording on. */
function realPlaywrightDriver(): VerifyDriver {
  return {
    async launch({ exe, attachDir, videoDir, videoName }): Promise<VerifyDriverApp> {
      const module = await loadPlaywright();
      let raw: unknown;
      let recordsVideo = true;
      try {
        raw = await module._electron.launch({ executablePath: exe, recordVideo: { dir: videoDir } });
      } catch (first) {
        // Some builds refuse recordVideo on Electron: retry without it.
        try {
          raw = await module._electron.launch({ executablePath: exe });
          recordsVideo = false;
        } catch (second) {
          throw new Error(`Electron launch failed: ${messageOf(second)} (with video recording: ${messageOf(first)})`);
        }
      }
      const app = raw as Partial<PlaywrightElectronHandle>;
      if (typeof app.firstWindow !== 'function' || typeof app.close !== 'function') {
        throw new Error('the playwright Electron handle is missing firstWindow/close');
      }
      const environment = await electronEnvironment(app);
      let page: PlaywrightPageHandle | null = null;
      const windowPage = async (): Promise<PlaywrightPageHandle> => {
        page ??= await app.firstWindow!();
        return page;
      };
      return {
        environment,
        firstWindow: () =>
          withTimeout(
            windowPage().then(() => undefined),
            FIRST_WINDOW_TIMEOUT_MS,
            `no first window within ${FIRST_WINDOW_TIMEOUT_MS / 1000} s`,
          ),
        async shot(file) {
          const target = await windowPage();
          await target.screenshot({ path: path.join(attachDir, file) });
        },
        async finish(keepVideo) {
          let videoPath: string | null = null;
          try {
            await app.close!();
            const target = page ?? app.context?.().pages().at(-1) ?? null;
            videoPath = (await target?.video()?.path()) ?? null;
          } catch {
            videoPath = null;
          }
          if (!recordsVideo || videoPath === null) {
            return { video: null };
          }
          // Playwright names the file itself; the walkthrough is renamed to
          // the contract's `verify-<stamp>-<ticket>.webm` inside videoDir.
          if (!keepVideo) {
            await fsp.rm(videoPath, { force: true }).catch(() => undefined);
            return { video: null };
          }
          const target = path.join(videoDir, videoName);
          if (path.normalize(videoPath) !== path.normalize(target)) {
            const moved = await fsp
              .rename(videoPath, target)
              .then(() => true)
              .catch(() => false);
            if (!moved) {
              await fsp.copyFile(videoPath, target).catch(() => null);
              await fsp.rm(videoPath, { force: true }).catch(() => undefined);
            }
          }
          return { video: await fsp.stat(target).then(() => videoName).catch(() => null) };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The harness.

/** One criterion's verdict — the structured form of the judge's decision. */
export interface VerifyCriterionVerdict {
  /** The criterion as written under `### Acceptance criteria`; null only
   *  for an unpaired overview shot. */
  readonly criterion: string | null;
  readonly passed: boolean;
  /** A failure reason or a judge remark; null = none. */
  readonly note: string | null;
}

/**
 * What the harness's `run` resolves to: the contract's VerifyRunResult,
 * plus the per-criterion verdicts the verify service turns into the
 * report's checkboxes. The fixed contract carries no verdict channel —
 * `findings` holds the human-readable mirror of the same decisions.
 * `verdicts` is empty whenever `error` is set (a refused run proves
 * nothing); the service then marks every criterion from the error alone.
 */
export interface VerifyRunOutcome extends VerifyRunResult {
  readonly verdicts: readonly VerifyCriterionVerdict[];
}

/** Test seams; production calls `createPlaywrightVerifyHarness()` bare. */
export interface PlaywrightVerifyHarnessDeps {
  /** The driver; default = the real lazy-Playwright Electron driver. */
  readonly driver?: VerifyDriver;
  /** The clock (the shot-file stamp); default = `new Date()`. */
  readonly now?: () => Date;
  /** Readiness settle after the first window, ms (default 10 s). */
  readonly settleMs?: number;
}

export function createPlaywrightVerifyHarness(deps: PlaywrightVerifyHarnessDeps = {}): VerifyHarness {
  const driver = deps.driver ?? realPlaywrightDriver();
  const now = deps.now ?? (() => new Date());
  const settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS;
  return {
    async run(input: VerifyRunInput): Promise<VerifyRunOutcome> {
      const stamp = formatVerifyStamp(now());
      const plan = planVerifyShots(input.criteria, stamp);
      const findings: string[] = [];
      if (plan.capped.length > 0) {
        findings.push(
          `no screenshot past the ${MAX_VERIFY_SHOTS}-shot cap: ${plan.capped.map((c) => `\`${c}\``).join(', ')}`,
        );
      }
      const refuse = (error: string): VerifyRunOutcome => ({
        environment: '',
        shots: [],
        findings: [...findings, error],
        video: null,
        error,
        verdicts: [],
      });

      if (input.proof === 'tests') {
        // E11-1: no UI change — the app is not started, nothing is shot or recorded.
        return {
          environment: 'tests only — no app started',
          shots: [],
          findings,
          video: null,
          error: null,
          verdicts: [],
        };
      }
      const exe = await findElectronExe(input.worktree).catch(() => null);
      if (exe === null) {
        return refuse(`no built app exe under ${path.join(input.worktree, 'release')} — pack the app before verifying`);
      }
      let app: VerifyDriverApp;
      try {
        app = await driver.launch({
          worktree: input.worktree,
          exe,
          command: input.command,
          attachDir: input.attachDir,
          videoDir: input.videoDir,
          videoName: `verify-${stamp}-${input.ticket}.webm`,
        });
      } catch (error) {
        return refuse(messageOf(error));
      }
      const launchedAt = now().getTime();

      // Readiness: the first window, then the settle delay.
      const readyStart = now();
      let readyNote: string | null = null;
      try {
        await app.firstWindow();
        await settle(settleMs);
      } catch (error) {
        readyNote = messageOf(error);
      }
      const readyMs = now().getTime() - readyStart.getTime();
      findings.push(`ready in ${(readyMs / 1000).toFixed(1)} s — first window plus ${(settleMs / 1000).toFixed(1)} s settle`);
      if (readyNote !== null) {
        const { video } = await app.finish(true).catch(() => ({ video: null }));
        findings.push(`never became ready: ${readyNote}`);
        return {
          environment: app.environment,
          shots: [],
          findings,
          video,
          error: `the app never became ready: ${readyNote}`,
          verdicts: [],
        };
      }

      // The shots: capture, then let the judge decide (a captured shot
      // passes when no judge ran).
      const shots: VerifyShot[] = [];
      const verdicts: VerifyCriterionVerdict[] = [];
      for (const planned of plan.shots) {
        let passed = true;
        let note: string | null = null;
        let stage: 'screenshot' | 'judge' | null = null;
        try {
          await app.shot(planned.file);
        } catch (error) {
          passed = false;
          stage = 'screenshot';
          note = messageOf(error);
        }
        if (passed && input.judge !== null && planned.criterion !== null) {
          try {
            const verdict = await input.judge.judge({
              criterion: planned.criterion,
              screenshotPath: path.join(input.attachDir, planned.file),
            });
            passed = verdict.passed;
            note = verdict.note;
            if (!passed) {
              stage = 'judge';
            }
          } catch (error) {
            passed = false;
            stage = 'judge';
            note = `judge failed to run: ${messageOf(error)}`;
          }
        }
        if (passed) {
          shots.push({ file: planned.file, criterion: planned.criterion, atMs: Math.max(0, now().getTime() - launchedAt) });
        }
        verdicts.push({ criterion: planned.criterion, passed, note });
        if (!passed) {
          const reason = note === null || note.trim() === '' ? '' : `: ${note}`;
          findings.push(`the ${stage ?? 'run'} failed on \`${planned.criterion}\`${reason}`);
        } else if (note !== null && note.trim() !== '') {
          findings.push(`judge note on \`${planned.criterion}\`: ${note}`);
        }
      }
      // A `ui` proof always keeps its walkthrough video (D12; E4's
      // failure-only rule is superseded).
      const keepVideo = true;
      // Capped criteria are verdicts too — the report shows one checkbox
      // per acceptance criterion, shot or no shot.
      for (const criterion of plan.capped) {
        verdicts.push({ criterion, passed: false, note: `no screenshot: past the ${MAX_VERIFY_SHOTS}-shot cap` });
      }

      const { video } = await app.finish(keepVideo).catch(() => ({ video: null }));
      return { environment: app.environment, shots, findings, video, error: null, verdicts };
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function settle(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
