import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { defaultExec, type ExecFn } from '../store/dk-process';
import { type ConversionPlan, type MigrationConfig, type TargetTicket } from './convert';
import { stubDocument } from './dricket-doc';

/**
 * APPLY: write a conversion plan into a SCRATCH dricket store (E14-3b).
 *
 * `dk` v0.6.1 cannot choose a ticket number or its creation data (`add` is
 * max + 1, R-28; the import R-10 is not coming -- owner decision 2026-11-05:
 * Drey has one user, the one-time migration does not wait). So the migration
 * writes the ticket files itself, in the exact on-disk format of dricket's
 * protocol (`tickets/<prefix>/<shard>/<id>/ticket.md` + `comments/`), with the
 * legacy number, `created_at` / `created_by` and stage, and publishes them on
 * the store's `tickets` branch with plain git: one `git fast-import` stream
 * (one commit per ticket -- the protocol's history replay wants one ticket per
 * commit), then ONE compare-and-swap of the ref (`merge --ff-only` when the
 * branch is checked out, else `update-ref` with the old value): linear, never
 * a force. Number gaps stay gaps (the protocol allows them). `dk validate` is
 * the judge of the result; nothing of dricket's write path is re-implemented
 * beyond the file format.
 */

export interface ScratchGuard {
  /** The legacy vault root: the store must be none of it, inside it, or around it. */
  readonly legacyRoot: string;
}

/** Windows MAX_PATH leaves room for dricket's `tickets/t/0000/t-17/comments/<stamp>-<author>.md` below the store. */
export const MAX_WINDOWS_STORE_PATH = 120;

/** Throws unless `storeDir` is safely away from the legacy vault. */
export function assertScratchStore(storeDir: string, guard: ScratchGuard): void {
  const store = normalise(storeDir);
  const legacy = normalise(guard.legacyRoot);
  if (store === legacy) {
    throw new Error(`refusing to apply into the legacy vault itself (${storeDir})`);
  }
  if (process.platform === 'win32' && path.resolve(storeDir).length > MAX_WINDOWS_STORE_PATH) {
    throw new Error(`the store path is ${path.resolve(storeDir).length} characters; on Windows keep it under ${MAX_WINDOWS_STORE_PATH} (dricket's deepest file, a comment, sits ~70 characters below it and git stops at 260)`);
  }
  if (store.startsWith(legacy + path.sep) || legacy.startsWith(store + path.sep)) {
    throw new Error(`refusing to apply: the store (${storeDir}) and the legacy vault (${guard.legacyRoot}) overlap`);
  }
}

function normalise(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** `dricket.toml` for the scratch store: Drey's stages and priorities, no quota. */
export function scratchConfigToml(config: Pick<MigrationConfig, 'stages' | 'priorities' | 'defaultPriority'>, admin: string): string {
  const list = (items: readonly string[]): string => `[${items.map((s) => `"${s}"`).join(', ')}]`;
  const terminal = config.stages[config.stages.length - 1]!;
  const claim = config.stages.filter((s) => s === 'build' || s === 'commit');
  return [
    'schema_version = 1',
    '',
    '[security]',
    `admins = ${list([admin])}`,
    'quota_tickets_per_day = 0',
    'secret_scan = true',
    '',
    '[priorities]',
    `values = ${list(config.priorities)}`,
    `default = "${config.defaultPriority}"`,
    '',
    '[stages]',
    `values = ${list(config.stages)}`,
    `initial = "${config.stages[0]}"`,
    `terminal = ${list([terminal])}`,
    `claim = ${list(claim.length > 0 ? claim : [config.stages[1] ?? config.stages[0]!])}`,
    'cancelled = "cancelled"',
    '',
  ].join('\n');
}

export interface ScratchStoreOptions {
  readonly bin: string;
  readonly storeDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly config: Pick<MigrationConfig, 'stages' | 'priorities' | 'defaultPriority'>;
  readonly admin: string;
  readonly exec?: ExecFn;
}

/**
 * Creates the scratch store (`dk init`, then the config on `main` the way an
 * admin's pull request would). An existing directory must be empty.
 */
export async function initScratchStore(options: ScratchStoreOptions): Promise<void> {
  const exec = options.exec ?? defaultExec;
  if (existsSync(options.storeDir) && readdirSync(options.storeDir).length > 0) {
    throw new Error(`${options.storeDir} is not empty; apply needs a fresh scratch directory`);
  }
  const run = async (file: string, args: string[]): Promise<void> => {
    const result = await exec(file, args, { env: options.env, timeoutMs: null, signal: undefined });
    if (result.failure !== null || result.code !== 0) {
      throw new Error(`${file} ${args.join(' ')} failed: ${(result.stderr || result.stdout || result.failure || '').trim().split('\n')[0]}`);
    }
  };
  await run(options.bin, ['init', options.storeDir, 't']);
  const git = (args: string[]): Promise<void> => run('git', ['-C', options.storeDir, ...args]);
  await git(['checkout', '-q', 'main']);
  writeFileSync(path.join(options.storeDir, 'dricket.toml'), scratchConfigToml(options.config, options.admin));
  await git(['add', 'dricket.toml']);
  await git(['-c', 'user.name=Drey migrate', '-c', 'user.email=migrate@drey.invalid', 'commit', '-q', '-m', 'scratch store configuration']);
  await git(['checkout', '-q', 'tickets']);
}

// ---------------------------------------------------------------------------

export type OutcomeStatus = 'created' | 'failed';

export interface ApplyOutcome {
  readonly number: number;
  readonly legacyId: string | null;
  readonly id: string;
  readonly status: OutcomeStatus;
  /** Revision of the written ticket file (0: freshly created); null when not written. */
  readonly rev: number | null;
  readonly error: string | null;
}

export interface ApplyResult {
  readonly outcomes: readonly ApplyOutcome[];
  /** True when every migrating ticket was written. */
  readonly complete: boolean;
  /** The ticket branch head after the apply; null when nothing was written. */
  readonly head: string | null;
  /** Commits added to the ticket branch. */
  readonly commits: number;
}

export interface ApplyOptions {
  /** The scratch store (a git repository, bare or not). */
  readonly storeDir: string;
  /** Environment of the git calls (a scratch HOME, `GIT_*`); default the process's. */
  readonly env?: NodeJS.ProcessEnv;
  /** The identity that authors everything (`DK_OWNER`): commits and notes. */
  readonly actor: string;
  /** Apply tickets that carry a blocking finding (a run stamp). Default false. */
  readonly allowBlocking?: boolean;
  /** The ticket branch; dricket's default. */
  readonly branch?: string;
  /** Fixed clock for tests. */
  readonly now?: () => Date;
  readonly onProgress?: (line: string) => void;
}

/** dricket's limits the format checks on write (`validate` re-checks all of them). */
const MAX_BODY_BYTES = 100_000;
const MAX_EXTENSION_BYTES = 1_000;
const PREFIX = 't';
const TICKETS_DIR = 'tickets';
const IMPORT_REF = 'refs/dricket-migrate/import';

export async function applyPlan(plan: ConversionPlan, options: ApplyOptions): Promise<ApplyResult> {
  const migrating = plan.conversions.filter((c) => c.target !== null);
  const blocked = migrating.filter((c) => c.blocking.length > 0);
  if (blocked.length > 0 && options.allowBlocking !== true) {
    throw new Error(`refusing to apply: ${blocked.map((c) => `${c.legacyId} (${c.blocking[0]})`).join('; ')}. Pass allowBlocking to override.`);
  }
  const say = options.onProgress ?? (() => undefined);
  const branch = options.branch ?? 'tickets';
  const ref = `refs/heads/${branch}`;
  const git = gitRunner(options.storeDir, options.env ?? process.env);
  const base = git(['rev-parse', '--verify', '-q', `${ref}^{commit}`], undefined, true).trim();
  if (base === '') {
    throw new Error(`the store has no ${branch} branch`);
  }
  if (git(['ls-tree', '-r', '--name-only', base, '--', `${TICKETS_DIR}/`]).trim() !== '') {
    throw new Error('refusing to apply: the store already holds tickets');
  }

  const targets = migrating.map((c) => c.target!).sort((a, b) => a.number - b.number);
  const now = (options.now ?? (() => new Date()))();
  const stamp = isoSeconds(now);
  const files = targets.map((target) => ({ target, ...buildFiles(target, options.actor, stamp) }));

  // Pre-flight: every file is checked before the first byte is written, so a failure leaves the store untouched.
  const problems = files.flatMap((f) => f.problems.map((problem) => ({ target: f.target, problem })));
  if (problems.length > 0) {
    return { outcomes: problems.map((p) => failure(p.target, p.problem)), complete: false, head: null, commits: 0 };
  }

  const actor = options.actor.replace(/[<>\s]/g, '');
  const identity = `${actor} <${actor}@dricket.invalid>`;
  const when = `${Math.floor(now.getTime() / 1000)} +0000`;
  const stream: Buffer[] = [];
  files.forEach((f, index) => {
    const message = `dricket: add ${f.target.id} (migrated from ${f.target.legacyId})`;
    stream.push(Buffer.from(`commit ${IMPORT_REF}\nauthor ${identity} ${when}\ncommitter ${identity} ${when}\ndata ${Buffer.byteLength(message)}\n${message}\n`));
    if (index === 0) {
      stream.push(Buffer.from(`from ${base}\n`));
    }
    for (const file of f.entries) {
      const data = Buffer.from(file.content, 'utf8');
      stream.push(Buffer.from(`M 100644 inline ${file.path}\ndata ${data.length}\n`), data, Buffer.from('\n'));
    }
    stream.push(Buffer.from('\n'));
  });
  stream.push(Buffer.from('done\n'));
  git(['fast-import', '--quiet', '--done'], Buffer.concat(stream));
  try {
    const head = git(['rev-parse', IMPORT_REF]).trim();
    publish(git, ref, base, head);
    const outcomes: ApplyOutcome[] = files.map((f) => ({ number: f.target.number, legacyId: f.target.legacyId, id: f.target.id, status: 'created', rev: 0, error: null }));
    for (const f of files) {
      say(`${f.target.legacyId} -> ${f.target.id} created`);
    }
    return { outcomes, complete: true, head, commits: files.length };
  } finally {
    git(['update-ref', '-d', IMPORT_REF], undefined, true);
  }
}

/** ff-only publication: ref, index and working tree together when the branch is checked out, else a CAS of the ref. */
function publish(git: GitRunner, ref: string, base: string, head: string): void {
  const checkedOut = git(['symbolic-ref', '-q', 'HEAD'], undefined, true).trim() === ref;
  if (checkedOut) {
    git(['merge', '--ff-only', '--quiet', head]);
  } else {
    git(['update-ref', '-m', 'dricket: migrated tickets', ref, head, base]);
  }
}

interface TicketFile {
  readonly path: string;
  readonly content: string;
}

interface BuiltFiles {
  readonly entries: readonly TicketFile[];
  readonly problems: readonly string[];
}

/** The files of one ticket: the document and, when the converter left a note, a comment. */
function buildFiles(target: TargetTicket, actor: string, stamp: string): BuiltFiles {
  const m = /^([a-z]+)-([1-9]\d*)$/.exec(target.id);
  if (m === null || m[1] !== PREFIX) {
    return { entries: [], problems: [`${target.id} is not a ${PREFIX}-<number> id`] };
  }
  const problems: string[] = [];
  const dir = `${TICKETS_DIR}/${PREFIX}/${String(Math.floor(Number(m[2]) / 1000)).padStart(4, '0')}/${target.id}`;
  const document = stubDocument(target, target.createdAt ?? stamp, target.createdBy ?? actor).replace(/\r\n/g, '\n');
  if (Buffer.byteLength(target.body) > MAX_BODY_BYTES) {
    problems.push(`the body is ${Buffer.byteLength(target.body)} bytes; dricket allows ${MAX_BODY_BYTES}`);
  }
  for (const [key, value] of Object.entries(target.extensions)) {
    if (!/^x-[a-z0-9][a-z0-9-]*$/.test(key) || /[\r\n]/.test(value) || Buffer.byteLength(value) > MAX_EXTENSION_BYTES) {
      problems.push(`extension ${key} is not a single line of at most ${MAX_EXTENSION_BYTES} bytes`);
    }
  }
  const entries: TicketFile[] = [{ path: `${dir}/ticket.md`, content: document }];
  for (const note of danglingNotes(target)) {
    const name = `${stamp.replace(/:/g, '-')}-${actor}.md`;
    entries.push({ path: `${dir}/comments/${name}`, content: `---\nticket: ${target.id}\nauthor: ${actor}\ncreated_at: ${stamp}\n---\n\n${note}\n` });
  }
  return { entries, problems };
}

function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

type GitRunner = (args: readonly string[], input?: Buffer, tolerateFailure?: boolean) => string;

function gitRunner(storeDir: string, env: NodeJS.ProcessEnv): GitRunner {
  return (args, input, tolerateFailure) => {
    const result = spawnSync('git', ['-C', storeDir, ...args], { env, input, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (result.error !== undefined) {
      throw result.error;
    }
    if (result.status !== 0) {
      if (tolerateFailure === true) {
        return '';
      }
      throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout || '').trim().split('\n')[0]}`);
    }
    return result.stdout;
  };
}

function danglingNotes(target: TargetTicket): string[] {
  const legacy = target.extensions['x-legacy-blocked-by'];
  if (legacy === undefined) {
    return [];
  }
  return [`Migration: legacy blocked-by was ${legacy}; entries outside the migrated set were removed from depends.`];
}

function failure(target: TargetTicket, error: string): ApplyOutcome {
  return { number: target.number, legacyId: target.legacyId, id: target.id, status: 'failed', rev: null, error };
}
