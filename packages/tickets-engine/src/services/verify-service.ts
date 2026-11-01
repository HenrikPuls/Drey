/**
 * The verify service (E4, ADR-0088 later change): the machine verification
 * step between the build and the owner's checkpoint. A run resolves the
 * ticket's worktree and launch command, drives the built app headless
 * through the acceptance criteria (the harness seam — Playwright in the
 * engine, a fake in the specs), persists the `## Verification` proof
 * section plus the screenshots into the tickets vault as ONE commit and
 * moves the ticket to the next phase. A failed or refused run logs one
 * line and leaves the ticket where it sits.
 *
 * Runs trigger two ways: manually (`verifyTicket`, any phase) and by the
 * auto-scan — every board change (debounced) re-checks the configured
 * verify phase for cards without a Verification section, one run at a
 * time per ticket. Not an agent run: no LLM, no fleet slot.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import {
  MAX_VERIFY_SHOTS,
  type VerificationCriterionProof,
  type VerificationReport,
  type VerifyHarness,
  type VerifyRunState,
  type VerifyStatus,
} from '../contracts/verify';
import type { BoardSnapshot, TicketCard } from '../contracts/tickets';
import { parseVerificationSection, renderVerificationSection, upsertVerificationSection } from '../core/verification';
import { acceptanceCommands, withLogLine } from '../core/ticket-files';
import { TicketsGit } from '../core/tickets-git';
import { nextPhaseIdOf } from '../fleet/chain';
import { worktreePathFor } from '../fleet/worktree-home';
import type { EngineBoardService } from './board-service';
import type { EngineHost, EngineVault } from './host';

/** The vault's attachment folder — the `verify-…` file names are ours (`img-…` stays the phone's). */
const ATTACHMENTS_DIR = 'tickets/attachments';
/** The config key of the phase the auto-scan drains; `verify` when unset. */
const VERIFY_PHASE_KEY = 'verify.phase';
/** One scan per burst of board changes. */
const SCAN_DEBOUNCE_MS = 1_000;

/** The config access the service needs — the engine's FileConfigStore fits. */
export interface VerifyConfigAccess {
  get<T>(key: string): Promise<T | undefined>;
}

export interface VerifyServiceDeps {
  readonly board: EngineBoardService;
  readonly host: EngineHost;
  readonly harness: VerifyHarness;
  readonly config: VerifyConfigAccess;
  readonly git: TicketsGit;
  /** The run's author (`verify@<host>`) — the section's tester and the Log lines' who. */
  readonly actor: string;
  readonly log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

export type VerifyTriggerResult = { readonly ok: true; readonly warning?: string } | { readonly ok: false; readonly error: string };

/** The card of one ticket id, wherever it sits on the board; null when absent. */
function findOnBoard(snap: BoardSnapshot, id: string): TicketCard | null {
  for (const column of snap.columns) {
    const found = column.tickets.find((t) => t.id === id);
    if (found !== undefined) {
      return found;
    }
  }
  return null;
}

export class VerifyService {
  private readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void;
  /** The tickets with a run in flight — one run at a time per ticket. */
  private readonly inFlight = new Set<string>();
  /** The latest live state per ticket (running/done/failed). */
  private readonly statuses = new Map<string, VerifyStatus>();
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly unsubscribeBoard: () => void;
  /**
   * The one scan at construction, settled: createEngine awaits it, so the
   * engine starts listening only after the board was checked for
   * candidates (and the startup IO has settled). Candidate runs
   * themselves proceed in the background.
   */
  readonly initialScan: Promise<void>;

  constructor(private readonly deps: VerifyServiceDeps) {
    this.log = deps.log ?? (() => undefined);
    this.unsubscribeBoard = deps.board.onChanged(() => this.scheduleScan());
    this.initialScan = this.runScanSafely();
  }

  /** Stops the auto-scan (timers + the board subscription). Runs already in flight finish on their own. */
  dispose(): void {
    if (this.scanTimer !== null) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    this.unsubscribeBoard();
  }

  /** The proof card's live state — the map's latest, `idle` while none exists. */
  status(input: { id: string }): VerifyStatus {
    return this.statuses.get(input.id) ?? { ticket: input.id, state: 'idle', report: null, error: null };
  }

  /** The invoke channel's name for {@link status} (BOARD_METHODS' `verifyStatus`). */
  verifyStatus(input: { id: string }): VerifyStatus {
    return this.status(input);
  }

  /**
   * Runs the verification for one ticket, whatever phase it sits in: the
   * harness walk, the persisted section, one commit, the move to the next
   * phase. A refusal (no repo, worktree or launch command) or a harness
   * error logs one line, fails the status and leaves the ticket put.
   */
  async verifyTicket(input: { id: string }): Promise<VerifyTriggerResult> {
    if (this.inFlight.has(input.id)) {
      return { ok: false, error: `${input.id} already has a verify run in flight` };
    }
    this.inFlight.add(input.id);
    this.setStatus(input.id, 'running', null, null);
    try {
      const outcome = await this.run(input.id);
      if (!outcome.ok) {
        // The refusals recorded their failed status inside run(); the
        // early returns (no vault, no such card) land here still running.
        if (this.statuses.get(input.id)?.state === 'running') {
          this.setStatus(input.id, 'failed', null, outcome.error);
        }
      }
      return outcome;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`verify ${input.id} crashed: ${message}`, 'error');
      this.setStatus(input.id, 'failed', null, message);
      return { ok: false, error: message };
    } finally {
      this.inFlight.delete(input.id);
    }
  }

  private async run(id: string): Promise<VerifyTriggerResult> {
    const snap = await this.deps.board.snapshot();
    const vaultId = snap.vaultId;
    const vault = vaultId === null ? null : (await this.deps.host.listVaults()).find((v) => v.id === vaultId) ?? null;
    if (vaultId === null || vault === null) {
      return { ok: false, error: 'no tickets vault detected' };
    }
    const card = findOnBoard(snap, id);
    if (card === null) {
      return { ok: false, error: `${id} is not on the board` };
    }
    const text = await this.deps.host.read(vaultId, card.path);

    const repo = card.meta.repo === null ? null : snap.repos.find((r) => r.name === card.meta.repo) ?? null;
    if (repo === null) {
      return this.refuse(vault, card, text, `verify refused — ${id} names no work repo — nothing to verify`);
    }
    const worktree = worktreePathFor(vault.path, repo, id);
    const worktreeThere = await fsp.stat(worktree).then((s) => s.isDirectory()).catch(() => false);
    if (!worktreeThere) {
      return this.refuse(vault, card, text, `verify refused — ${id} has no worktree yet — nothing to verify`);
    }
    let command: string | null = repo.launch;
    if (command === null) {
      // The default a Drey checkout carries (the launchVersion convention):
      // the packaged app from a second, lock-free instance beside the running one.
      if (await fsp.stat(path.join(worktree, 'dev.ps1')).then((s) => s.isFile()).catch(() => false)) {
        command = 'powershell -NoProfile -ExecutionPolicy Bypass -File dev.ps1 -Built -Multi';
      }
    }
    if (command === null) {
      return this.refuse(vault, card, text, `verify refused — ${id}'s repo names no launch command and the worktree has no dev.ps1`);
    }

    const criteria = acceptanceCommands(text);
    const attachDir = this.deps.host.resolveAssetPath(vaultId, ATTACHMENTS_DIR);
    if (attachDir === null) {
      return this.refuse(vault, card, text, `verify refused — ${ATTACHMENTS_DIR} escapes the vault`);
    }
    await fsp.mkdir(attachDir, { recursive: true });
    const result = await this.deps.harness.run({ worktree, command, criteria, attachDir, judge: null });
    if (result.error !== null) {
      return this.refuse(vault, card, text, `verify failed — ${result.error}`);
    }

    const now = new Date();
    const shots = result.shots.slice(0, MAX_VERIFY_SHOTS);
    const remaining = [...shots];
    const proofs: VerificationCriterionProof[] = criteria.map((criterion) => {
      const at = remaining.findIndex((s) => s.criterion === criterion);
      const shot = at >= 0 ? remaining.splice(at, 1)[0]! : null;
      return shot !== null
        ? { command: criterion, passed: true, screenshot: shot.file, note: null }
        : { command: criterion, passed: false, screenshot: null, note: 'no screenshot' };
    });
    const passed = proofs.filter((p) => p.passed).length;
    const report: VerificationReport = {
      testedAt: now.toISOString(),
      tester: this.deps.actor,
      environment: result.environment,
      criteria: proofs,
      findings: [...result.findings],
    };

    let patched = upsertVerificationSection(text, renderVerificationSection(report));
    patched = withLogLine(patched, now, this.deps.actor, `verified — ${passed}/${proofs.length} criteria green`);
    await this.deps.host.write(vaultId, card.path, patched);
    const shotPaths = shots.map((s) => `${ATTACHMENTS_DIR}/${s.file}`);
    const warning = await this.commit(vault, [card.path, ...shotPaths], `tickets: ${id} verified`);
    this.deps.host.announceChanges(vaultId, [card.path, ...shotPaths]);
    this.setStatus(id, 'done', report, null);

    const next = nextPhaseIdOf(snap.columns, card.phase);
    if (next !== null) {
      const moved = await this.deps.board.transition({ id, from: card.phase, to: next, actor: this.deps.actor });
      if (!moved.ok) {
        this.log(`verify finished for ${id} but the move did not happen: ${moved.error}`, 'warn');
        return { ok: false, error: moved.error };
      }
    }
    return { ok: true, ...(warning === null ? {} : { warning }) };
  }

  /**
   * A run that ends before any proof exists: one Log line, the failed
   * status, no Verification section, the ticket stays in its phase. The
   * line is committed like every machine write.
   */
  private async refuse(vault: EngineVault, card: TicketCard, text: string, line: string): Promise<VerifyTriggerResult> {
    const patched = withLogLine(text, new Date(), this.deps.actor, line);
    await this.deps.host.write(vault.id, card.path, patched);
    const warning = await this.commit(vault, [card.path], `tickets: ${card.id} verify failed`);
    this.deps.host.announceChanges(vault.id, [card.path]);
    this.setStatus(card.id, 'failed', null, line);
    return { ok: false, error: line, ...(warning === null ? {} : { warning }) };
  }

  private async commit(vault: EngineVault, vaultRelPaths: readonly string[], message: string): Promise<string | null> {
    const location = await this.deps.git.locate(vault.path);
    if (location === null) {
      return 'the tickets vault is not a git repository — the change is not versioned';
    }
    try {
      await this.deps.git.commitPaths(
        location.root,
        vaultRelPaths.map((p) => `${location.prefix}${p}`),
        message,
      );
      return null;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.log(`git commit failed: ${text}`, 'warn');
      return `git commit failed: ${text.split('\n')[0]}`;
    }
  }

  private setStatus(id: string, state: VerifyRunState, report: VerificationReport | null, error: string | null): void {
    this.statuses.set(id, { ticket: id, state, report, error });
  }

  // --- the auto-scan --------------------------------------------------------

  private scheduleScan(): void {
    if (this.scanTimer !== null) {
      return;
    }
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      void this.runScanSafely();
    }, SCAN_DEBOUNCE_MS);
  }

  private async runScanSafely(): Promise<void> {
    try {
      await this.scan();
    } catch (error) {
      this.log(`verify scan failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  /**
   * The auto-run pass: every card in the configured verify phase whose
   * ticket file has no Verification section gets a run — the proofs'
   * missing section is the only trigger, so a scanned-once ticket never
   * re-runs until a new run is written over its section.
   */
  private async scan(): Promise<void> {
    const phase = await this.verifyPhase();
    const snap = await this.deps.board.snapshot();
    const column = snap.columns.find((c) => c.phase.id === phase);
    if (column === undefined) {
      return;
    }
    for (const card of column.tickets) {
      if (this.inFlight.has(card.id)) {
        continue;
      }
      const reply = await this.deps.board.readTicket(card.id);
      if (!reply.ok || parseVerificationSection(reply.text) !== null) {
        continue;
      }
      // The run proceeds in the background; verifyTicket never rejects
      // (its catch turns a crash into a failed status + a log line).
      void this.verifyTicket({ id: card.id }).then((outcome) => {
        if (!outcome.ok) {
          this.log(`verify scan: ${card.id}: ${outcome.error}`, 'warn');
        }
      });
    }
  }

  private async verifyPhase(): Promise<string> {
    const configured = await this.deps.config.get<unknown>(VERIFY_PHASE_KEY);
    const phase = typeof configured === 'string' ? configured.trim() : '';
    return phase === '' ? 'verify' : phase;
  }
}
