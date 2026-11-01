import type { TransitionPatch } from './ticket-files';
import { patchTicketFile, withLogLine } from './ticket-files';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The machine's result: the ok:false variant names the error; ok:true
 * carries the optional warnings (commit/push are warning-level) and the
 * resulting path. Structurally assignable to the board's richer
 * MutationResult — the machine never produces `moved`.
 */
export type TransitionResult =
  | { readonly ok: false; readonly error: string }
  | { readonly ok: true; readonly warning?: string; readonly path?: string };

/**
 * THE one transition machine (ADR-0088, E1). Every ticket move — the
 * board's `transition`, archive, unarchive, the Ready card's Accept /
 * Send back and the drift treatment — is the same pipeline with different
 * parameters:
 *
 *   read → patch (+ optional extra Log line) → [rename] → write
 *        → one commit → the optional push → announce
 *
 * Before E1 the five call sites each owned a copy of this pipeline
 * (`moveCard`, `archiveCard`, `unarchive`, `treatDrift`, `acceptTicket`
 * in the plugin's board service). `acceptTicket` stays a dispatcher by
 * nature (terminal phase archives, anything else moves); the rest build a
 * {@link TransitionSpec} and run it here.
 *
 * The machine is pure domain: all IO arrives injected through
 * {@link TransitionIo}, so `core/` keeps its no-node/no-Electron rule and
 * the spec covers every step with fakes.
 */

/** The IO the machine needs, supplied by the host (plugin board service today, engine server in E2). */
export interface TransitionIo {
  /** Read a vault-relative ticket file. */
  read(path: string): Promise<string>;
  /** Write a vault-relative ticket file (no announcement — the machine announces once at the end). */
  write(path: string, text: string): Promise<void>;
  /**
   * mkdir the target directory and rename `from` → `to` (both vault-relative).
   * A structured failure keeps the current wording verbatim: a path that
   * escapes the vault is `ticket path escapes the vault`, a filesystem
   * error is `move failed: …`.
   */
  renameInto(fromPath: string, toPath: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** One commit for exactly these vault-relative paths; a warning string or null. */
  commit(paths: readonly string[], message: string): Promise<string | null>;
  /** The optional auto-push (`pipeline.md push:`); a warning string or null. */
  push(remote: string | null): Promise<string | null>;
  /** The closing announcement: the vault round plus the board-changed signal. */
  announce(changedPaths: readonly string[], deletedPaths: readonly string[]): void;
}

export interface TransitionSpec {
  /** The ticket id — the commit message and results name it. */
  readonly id: string;
  /** Current vault-relative path. */
  readonly fromPath: string;
  /**
   * Pre-read content: the drift treatment already holds the file's text
   * (read in bulk by the normalization pass) and must not re-read — the
   * on-disk file may have changed between listing and treatment, and the
   * treatment patches what the pass saw.
   */
  readonly text?: string;
  /**
   * When the machine reads via {@link TransitionIo.read} and it rejects,
   * this error is returned instead of propagating (the unarchive wording
   * is specific). Without it a read failure propagates to the caller —
   * the historical behaviour of the board moves.
   */
  readonly readError?: string;
  /** The frontmatter/Log patch — see `patchTicketFile`. */
  readonly patch: TransitionPatch;
  /** An optional second Log line after the ordinary `<from> -> <to>` line (the send-back note). */
  readonly extraLog?: string;
  /** Target vault-relative path; absent = in-place patch (the drift treatment never renames). */
  readonly toPath?: string;
  /** Commit message, already formatted (`tickets: T-0001 build -> review`). */
  readonly commitMessage: string;
  /** `pipeline.md push:` remote, null = no push. */
  readonly pushRemote: string | null;
}

/**
 * Run one transition. Never throws for patch/write/commit/push failures —
 * those surface as `ok: false` (or as warnings on an `ok: true`). A read
 * failure propagates unless the spec names a `readError`.
 */
export async function runTransition(io: TransitionIo, spec: TransitionSpec): Promise<TransitionResult> {
  let text: string;
  if (spec.text !== undefined) {
    text = spec.text;
  } else {
    try {
      text = await io.read(spec.fromPath);
    } catch (error) {
      if (spec.readError !== undefined) {
        return { ok: false, error: spec.readError };
      }
      throw error;
    }
  }

  let patched: string;
  try {
    patched = patchTicketFile(text, spec.patch);
    if (spec.extraLog !== undefined) {
      patched = withLogLine(patched, spec.patch.now, spec.patch.actor, spec.extraLog);
    }
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }

  const toPath = spec.toPath ?? spec.fromPath;
  if (spec.toPath !== undefined) {
    const moved = await io.renameInto(spec.fromPath, spec.toPath);
    if (!moved.ok) {
      return { ok: false, error: moved.error };
    }
  }
  try {
    await io.write(toPath, patched);
  } catch (error) {
    return { ok: false, error: `move failed: ${messageOf(error)}` };
  }

  const commitPaths = spec.toPath !== undefined ? [spec.fromPath, spec.toPath] : [spec.fromPath];
  const warning = await io.commit(commitPaths, spec.commitMessage);
  // The optional auto-push (T-0041): warning-level, never a failed move.
  const pushWarning = await io.push(spec.pushRemote);
  const warnings = [warning, pushWarning].filter((w): w is string => w !== null);
  io.announce(
    [toPath],
    spec.toPath !== undefined ? [spec.fromPath] : [],
  );
  return {
    ok: true,
    path: toPath,
    ...(warnings.length === 0 ? {} : { warning: warnings.join('; ') }),
  };
}
