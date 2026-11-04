import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defaultExec, type DkProcess, type ExecFn } from '../store/dk-process';
import { toDisplayId } from '../store/ids';
import { type ConversionPlan, type MigrationConfig, type TargetTicket } from './convert';
import { patchDricketDocument } from './dricket-doc';

/**
 * APPLY: write a conversion plan into a SCRATCH dricket store through `dk`
 * (E14-3). Nothing here re-implements dricket: tickets are created with
 * `dk add` (which allocates the next number), then one whole-ticket
 * `dk put --claim --if-version` fills in what `add` has no flag for. Both are
 * the shipped v0.6.0 write path; every document is validated by `dk`.
 *
 * Two things v0.6.0 cannot do, both filed as R-26 (and R-10's import would
 * remove both):
 * - choose the ticket NUMBER: `add` is max + 1, so a gap between migrated
 *   numbers is filled with cancelled placeholder tickets (`placeholder`
 *   label) to keep `T-0063` <-> `t-63`;
 * - choose `created_at` / `created_by`: dk stamps now and the importer; the
 *   legacy values travel as `x-created-at` / `x-created-by`.
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

export type OutcomeStatus = 'created' | 'placeholder' | 'failed';

export interface ApplyOutcome {
  readonly number: number;
  readonly legacyId: string | null;
  readonly id: string;
  readonly status: OutcomeStatus;
  readonly rev: number | null;
  readonly error: string | null;
}

export interface ApplyResult {
  readonly outcomes: readonly ApplyOutcome[];
  /** True when every migrating ticket was written. */
  readonly complete: boolean;
}

export interface ApplyOptions {
  readonly dk: DkProcess;
  /** The identity that creates everything (`DK_OWNER`). */
  readonly actor: string;
  /** Apply tickets that carry a blocking finding (a run stamp). Default false. */
  readonly allowBlocking?: boolean;
  /** Scratch folder for the put payloads; default an OS temp dir, removed afterwards. */
  readonly tempDir?: string;
  readonly onProgress?: (line: string) => void;
}

export async function applyPlan(plan: ConversionPlan, options: ApplyOptions): Promise<ApplyResult> {
  const migrating = plan.conversions.filter((c) => c.target !== null);
  const blocked = migrating.filter((c) => c.blocking.length > 0);
  if (blocked.length > 0 && options.allowBlocking !== true) {
    throw new Error(`refusing to apply: ${blocked.map((c) => `${c.legacyId} (${c.blocking[0]})`).join('; ')}. Pass allowBlocking to override.`);
  }
  const tmp = options.tempDir ?? mkdtempSync(path.join(os.tmpdir(), 'drey-migrate-'));
  mkdirSync(tmp, { recursive: true });
  const say = options.onProgress ?? (() => undefined);
  const outcomes: ApplyOutcome[] = [];
  const state = await options.dk.call(['ls'], { write: false });
  const existing = (state as { tickets?: unknown[] | null } | null)?.tickets ?? [];
  if (existing.length > 0) {
    throw new Error('refusing to apply: the store already holds tickets');
  }

  let next = 1;
  try {
    const targets = migrating.map((c) => c.target!).sort((a, b) => a.number - b.number);
    for (const target of targets) {
      while (next < target.number) {
        const o = await createPlaceholder(options, tmp, next);
        outcomes.push(o);
        say(`${o.id} placeholder ${o.status}`);
        if (o.status === 'failed') {
          return { outcomes, complete: false };
        }
        next += 1;
      }
      if (target.number < next) {
        outcomes.push(failure(target, `number ${target.number} is below the next free number ${next}`));
        return { outcomes, complete: false };
      }
      const o = await createTicket(options, tmp, target);
      outcomes.push(o);
      say(`${target.legacyId} -> ${o.id} ${o.status}${o.error !== null ? `: ${o.error}` : ''}`);
      if (o.status === 'failed') {
        return { outcomes, complete: false };
      }
      next = target.number + 1;
    }
    return { outcomes, complete: true };
  } finally {
    if (options.tempDir === undefined) {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

async function createTicket(options: ApplyOptions, tmp: string, target: TargetTicket): Promise<ApplyOutcome> {
  try {
    const addArgs = ['add', '--unclaimed', '--kind', target.kind, '--priority', target.priority, '-m', target.title, '-d', 'Migrated from the legacy tickets vault.'];
    const added = asRecord(await options.dk.call(addArgs, { write: true, actor: options.actor }));
    const id = String(added['id'] ?? '');
    if (id !== target.id) {
      return failure(target, `dk allocated ${id}, expected ${target.id}`);
    }
    const rev = await fillIn(options, tmp, id, (content) => patchDricketDocument(content, target));
    let note: string | null = null;
    for (const warning of danglingNotes(target)) {
      try {
        await options.dk.call(['comment', id, '-m', warning], { write: true, actor: options.actor });
      } catch (error) {
        // The ticket itself is written; a missing note must not stop the run (it is in x-legacy-blocked-by too).
        note = `created, but the migration comment was not written: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return { number: target.number, legacyId: target.legacyId, id, status: 'created', rev, error: note };
  } catch (error) {
    return failure(target, error instanceof Error ? error.message : String(error));
  }
}

async function createPlaceholder(options: ApplyOptions, tmp: string, number: number): Promise<ApplyOutcome> {
  const id = `t-${number}`;
  try {
    const args = ['add', '--unclaimed', '--kind', 'human', '-l', 'placeholder', '-m', `Unused number ${toDisplayId(id)}`, '-d', 'Keeps the number free so later tickets keep their ids (dk v0.6.0 has no import with a fixed id, R-26).'];
    const added = asRecord(await options.dk.call(args, { write: true, actor: options.actor }));
    if (String(added['id'] ?? '') !== id) {
      return { number, legacyId: null, id, status: 'failed', rev: null, error: `dk allocated ${String(added['id'])}, expected ${id}` };
    }
    const rev = await fillIn(options, tmp, id, (content) => content.replace(/^stage: .*$/m, 'stage: cancelled'));
    return { number, legacyId: null, id, status: 'placeholder', rev, error: null };
  } catch (error) {
    return { number, legacyId: null, id, status: 'failed', rev: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** show -> patch -> `put --claim --if-version`; returns the new rev. */
async function fillIn(options: ApplyOptions, tmp: string, id: string, patch: (content: string) => string): Promise<number | null> {
  const shown = asRecord(await options.dk.call(['show', id], { write: false }));
  const content = String(shown['content'] ?? '');
  const rev = Number(/^rev: (\d+)$/m.exec(content)?.[1] ?? 0);
  const file = path.join(tmp, `${id}.md`);
  writeFileSync(file, patch(content), 'utf8');
  const put = asRecord(await options.dk.call(['put', id, '-F', file, '--claim', '--if-version', String(rev)], { write: true, actor: options.actor }));
  const newRev = put['rev'];
  return typeof newRev === 'number' ? newRev : null;
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

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('dk answered something that is not an object');
  }
  return value as Record<string, unknown>;
}
