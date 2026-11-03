/**
 * The verification contract (E4, ADR-0088 later change): the shapes the
 * verify harness, the verify service and the proof card exchange. The
 * ticket-file format (`## Verification`) is core/verification.ts; the
 * full specification is specs/ticket-schema.md.
 *
 * The flow: the verify service resolves the ticket's worktree and launch
 * command, runs the harness (Playwright against the built app), persists
 * the report into the ticket file and moves the ticket to the owner's
 * checkpoint. One verify run is a machine step, not an agent run.
 */

/** The most screenshots one verify run persists — the phone's proof card
 *  shows them inline; beyond six the owner stops looking. */
export const MAX_VERIFY_SHOTS = 6;

/** One acceptance criterion's verdict. */
export interface VerificationCriterionProof {
  /** The criterion exactly as written under `### Acceptance criteria`. */
  readonly command: string;
  /** The judge's verdict; true when no judge ran and the shot exists. */
  readonly passed: boolean;
  /** The attachment file name (`verify-….png`); null = no screenshot. */
  readonly screenshot: string | null;
  /** A short human note (a failure reason, a judge remark); null = none. */
  readonly note: string | null;
}

/** The persisted verification report — `## Verification`'s in-memory twin. */
export interface VerificationReport {
  /** When the run happened, ISO-8601. */
  readonly testedAt: string;
  /** Who ran it (`verify@<host>`). */
  readonly tester: string;
  /** One line: the app build and the platform (`Electron 34.2.0 on win32`). */
  readonly environment: string;
  readonly criteria: readonly VerificationCriterionProof[];
  /** Auffälligkeiten — what the runner noticed beyond the criteria. */
  readonly findings: readonly string[];
  /** The walkthrough video's file name in `tickets/videos/` (`ui` proof); null = none. */
  readonly video?: string | null;
  /** The size limit freed the video (`Video removed (size limit).`); the player is replaced by the note. */
  readonly videoRemoved?: boolean;
  /** The video's chapters, one per shot criterion: the offset and the criterion. */
  readonly videoChapters?: readonly VideoChapter[];
}

export interface VideoChapter {
  /** Milliseconds from the video's start. */
  readonly atMs: number;
  readonly label: string;
}

/**
 * The judge seam (E4 stub): a vision/LLM evaluation of one captured
 * screenshot against its criterion. The default run has no judge — a
 * captured shot counts as passed; the section's Findings carry the
 * caveats until a judge lands.
 */
export interface VerifyJudge {
  judge(input: {
    readonly criterion: string;
    readonly screenshotPath: string;
  }): Promise<{ readonly passed: boolean; readonly note: string | null }>;
}

/** The harness's input. */
export interface VerifyRunInput {
  /** The ticket's worktree — the built app lives there. */
  readonly worktree: string;
  /** The repo's launch command (repos.md `launch:`) — the driver's
   *  documentation and its shell fallback; null = the Electron default. */
  readonly command: string | null;
  /** The ticket the run proves — the video's file name carries its id. */
  readonly ticket: string;
  /** Proof mode (E11-1): the app is launched, shot and recorded for `ui` only. */
  readonly proof: 'ui' | 'tests';
  /** Where the walkthrough video goes — the vault's `tickets/videos/` folder. */
  readonly videoDir: string;
  /** The ticket's acceptance commands, in order. */
  readonly criteria: readonly string[];
  /** Where the screenshots go — the vault's `tickets/attachments/` folder. */
  readonly attachDir: string;
  /** Optional judge; null = a captured shot passes its criterion. */
  readonly judge: VerifyJudge | null;
}

/** One captured screenshot. */
export interface VerifyShot {
  /** The file name inside `attachDir` (`verify-….png`). */
  readonly file: string;
  /** The criterion the shot proves; null = an unpaired overview shot. */
  readonly criterion: string | null;
  /** Milliseconds from the recording's start to this shot — the video chapter's offset. */
  readonly atMs?: number;
}

/** The harness's result — what the service persists. */
export interface VerifyRunResult {
  readonly environment: string;
  readonly shots: readonly VerifyShot[];
  readonly findings: readonly string[];
  /** The walkthrough recording (Playwright video), file name in `videoDir`; null (always null for `tests`). */
  readonly video: string | null;
  /** The run's error — a refused launch, a never-ready app; null = fine. */
  readonly error: string | null;
}

/** The harness seam the engine composes. */
export interface VerifyHarness {
  run(input: VerifyRunInput): Promise<VerifyRunResult>;
}

/** The proof card's live state. */
export type VerifyRunState = 'idle' | 'running' | 'done' | 'failed';

export interface VerifyStatus {
  readonly ticket: string;
  readonly state: VerifyRunState;
  /** The latest persisted report; null while none exists. */
  readonly report: VerificationReport | null;
  /** The failure line of the last run; null while none. */
  readonly error: string | null;
}
