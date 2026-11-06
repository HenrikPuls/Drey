import { mkdirSync, readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { defaultExec, DkProcess } from '../store/dk-process';
import { DricketTicketStore } from '../store/dricket-ticket-store';
import { applyPlan, assertScratchStore, initScratchStore } from './apply';
import { buildPlan, DEFAULT_MIGRATION_CONFIG, stageOfLegacyPhase, type MigrationConfig } from './convert';
import { readLegacyVault } from './legacy-vault';
import { renderDryRun, renderReport } from './report';
import { reverseTicket, type DricketComment } from './reverse';
import { readStoreComments } from './reverse-comments';
import { collectStoreRows, rowsFromLegacy, shadowDiff, type ShadowDiff } from './shadow-diff';

/**
 * `migrate-tickets` (E14-3): dry run | apply into a scratch store | reverse.
 *
 *   node scripts/migrate-tickets.mjs --legacy <vault> --allow <ids.txt>            # dry run (default)
 *   node scripts/migrate-tickets.mjs --legacy <vault> --allow <ids.txt> --apply --store <new dir> [--report <file>]
 *   node scripts/migrate-tickets.mjs --reverse --store <dricket store> --out <new dir>
 *
 * The legacy vault is only ever read. `--apply` refuses a store that is, is
 * inside, or contains the legacy vault, and a store that is not empty.
 */

export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

interface Args {
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
}

const VALUE_OPTIONS = ['legacy', 'allow', 'store', 'report', 'dk', 'actor', 'out', 'data', 'home', 'stages'];
const FLAG_OPTIONS = ['apply', 'dry-run', 'reverse', 'allow-live-runs', 'include-archive', 'help'];

export function parseArgs(argv: readonly string[]): Args {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const name = arg.startsWith('--') ? arg.slice(2) : '';
    if (FLAG_OPTIONS.includes(name)) {
      flags.add(name);
    } else if (VALUE_OPTIONS.includes(name) && i + 1 < argv.length) {
      values.set(name, argv[i + 1]!);
      i += 1;
    } else {
      throw new Error(`unknown or incomplete option "${arg}"`);
    }
  }
  return { flags, values };
}

/** One id per line (`T-0010`), `#` comments and blank lines ignored; ids may be followed by text. */
export function parseAllowList(text: string): string[] {
  const ids: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') {
      continue;
    }
    for (const m of line.matchAll(/\bT-\d{1,}\b/g)) {
      ids.push(m[0]);
    }
  }
  return [...new Set(ids)];
}

const USAGE = [
  'usage:',
  '  migrate-tickets --legacy <vault> --allow <ids.txt>                               dry run (read-only)',
  '  migrate-tickets --legacy <vault> --allow <ids.txt> --apply --store <new dir>     into a scratch dricket store',
  '  migrate-tickets --reverse --store <dricket store> --out <new dir>                store -> legacy files',
  'options: --report <file> --dk <path> --actor <id> --data <dir> --home <dir> --allow-live-runs --include-archive (archive/ -> done + label archived)',
  '         --stages a,b,c (reverse: the stage list of the store; default inbox,plan,build,review,sign-off,done)',
].join('\n');

export async function runMigrateCli(argv: readonly string[], io: CliIo, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 2;
  }
  if (args.flags.has('help')) {
    io.out(USAGE + '\n');
    return 0;
  }
  try {
    return args.flags.has('reverse') ? await runReverse(args, io, env) : await runForward(args, io, env);
  } catch (error) {
    io.err(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function dkEnv(args: Args, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = args.values.get('home');
  return home === undefined
    ? env
    : { ...env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), XDG_CONFIG_HOME: path.join(home, '.config') };
}

async function runForward(args: Args, io: CliIo, env: NodeJS.ProcessEnv): Promise<number> {
  const legacy = required(args, 'legacy');
  const allowFile = required(args, 'allow');
  const selected = parseAllowList(readFileSync(allowFile, 'utf8'));
  if (selected.length === 0) {
    throw new Error(`${allowFile} lists no ticket ids`);
  }
  const config: MigrationConfig = { ...DEFAULT_MIGRATION_CONFIG, selected, includeArchive: args.flags.has('include-archive') };
  const vault = readLegacyVault(legacy);
  const plan = buildPlan(vault, config);
  io.out(renderDryRun(plan));

  const apply = args.flags.has('apply');
  let applyResult = null;
  let shadow: ShadowDiff | null = null;
  let dkVersion: string | null = null;
  let validation: string | null = null;
  const storeDir = args.values.get('store') ?? null;

  if (apply) {
    if (storeDir === null) {
      throw new Error('--apply needs --store <new scratch directory>');
    }
    assertScratchStore(storeDir, { legacyRoot: legacy });
    const bin = args.values.get('dk') ?? 'dk';
    const actor = args.values.get('actor') ?? 'owner@legion';
    const callEnv = dkEnv(args, env);
    await initScratchStore({ bin, storeDir, env: callEnv, config, admin: actor });
    const dk = new DkProcess({ bin, store: path.resolve(storeDir), dataDir: args.values.get('data') ?? null, env: callEnv });
    dkVersion = await dk.version();
    applyResult = await applyPlan(plan, { storeDir: path.resolve(storeDir), env: callEnv, actor, allowBlocking: args.flags.has('allow-live-runs'), onProgress: (line) => io.out(`  ${line}\n`) });
    if (applyResult.complete) {
      const dataDir = args.values.get('data');
      const validated = await defaultExec(bin, ['validate'], { env: { ...callEnv, DK_STORE: path.resolve(storeDir), DK_OWNER: actor, ...(dataDir === undefined ? {} : { DK_DATA_DIR: dataDir }) }, timeoutMs: null, signal: undefined });
      validation = validated.code === 0 && validated.failure === null ? 'dk validate: clean' : `dk validate FAILED (exit ${String(validated.code)}): ${(validated.stdout + validated.stderr).trim().slice(0, 2000)}`;
      io.out(`${validation}\n`);
    }
    const store = new DricketTicketStore(dk);

    const migratedIds = new Set(plan.conversions.filter((c) => c.target !== null).map((c) => c.legacyId));
    shadow = shadowDiff(rowsFromLegacy(vault.tickets.filter((t) => migratedIds.has(t.id)), (phase) => stageOfLegacyPhase(phase, config) ?? phase), await collectStoreRows(store));
    io.out(`shadow diff: ${shadow.identical ? 'identical' : `${shadow.differences.length} difference(s)`}, ${shadow.declared.length} declared\n`);
  }

  const reportPath = args.values.get('report');
  if (reportPath !== undefined) {
    const text = renderReport(plan, { legacyRoot: legacy, storeDir, generatedAt: new Date().toISOString(), dkVersion, validation }, applyResult, shadow);
    const reportDir = path.dirname(path.resolve(reportPath));
    if (!existsSync(reportDir)) {
      mkdirSync(reportDir, { recursive: true });
    }
    writeFileSync(reportPath, text);
    io.out(`report written to ${reportPath}\n`);
  }
  if (applyResult !== null && (!applyResult.complete || (validation !== null && !validation.endsWith('clean')))) {
    return 1;
  }
  return 0;
}

async function runReverse(args: Args, io: CliIo, env: NodeJS.ProcessEnv): Promise<number> {
  const storeDir = required(args, 'store');
  const out = required(args, 'out');
  if (existsSync(out) && readdirSync(out).length > 0) {
    throw new Error(`${out} is not empty; the reverse converter writes into a fresh directory`);
  }
  const dk = new DkProcess({ bin: args.values.get('dk') ?? 'dk', store: path.resolve(storeDir), dataDir: args.values.get('data') ?? null, env: dkEnv(args, env) });
  const store = new DricketTicketStore(dk);
  const stagesArg = args.values.get('stages');
  const phases = stagesArg === undefined ? DEFAULT_MIGRATION_CONFIG.stages : stagesArg.split(',').map((s) => s.trim()).filter((s) => s !== '');
  let comments = new Map<string, DricketComment[]>();
  try {
    comments = readStoreComments(path.resolve(storeDir));
  } catch (error) {
    io.out(`comments are NOT carried (the store's files could not be read: ${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)}) - they stay in the store\n`);
  }
  let written = 0;
  for (const record of await store.list()) {
    const detail = await store.show(record.id);
    const reversed = reverseTicket({ content: detail.text, comments: comments.get(record.id) ?? [] }, { phases });
    const target = path.join(out, reversed.relPath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, reversed.text);
    written += 1;
    for (const lost of reversed.lost) {
      io.out(`${reversed.id}: ${lost}\n`);
    }
  }
  io.out(`reverse: ${written} ticket file(s) written to ${out}\n`);
  return 0;
}

function required(args: Args, name: string): string {
  const value = args.values.get(name);
  if (value === undefined) {
    throw new Error(`--${name} is required\n${USAGE}`);
  }
  return value;
}
