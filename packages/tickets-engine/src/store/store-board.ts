import { stringify } from 'yaml';
import type { BoardSnapshot, PipelinePhase } from '../contracts/tickets';
import type { TicketDetail } from '../ports/ticket-store';
import { assembleBoard, type AssembleInput, type BoardFile } from '../core/ticket-board';

/**
 * The board over a store's `TicketDetail[]` instead of ticket files (E14-2,
 * ADR-0090). Pure: no IO, no `dk`.
 *
 * The one rule that keeps both backends equal by construction: a record is
 * folded back into the LEGACY ticket shape (front matter `phase directory +
 * Drey keys`) and then runs through the very same `assembleBoard` — column
 * membership, derived order, `blocked` / `blocks`, issues and card workers are
 * therefore computed by one piece of code, not two. What this module owns is
 * only the translation of dricket's vocabulary into Drey's (below).
 *
 * Field map (dricket -> Drey ticket key):
 *
 *   id, title, priority            -> same
 *   stage                          -> phase (see {@link resolvePhase})
 *   depends                        -> blocked-by   (blocked is derived, never stored)
 *   parent                         -> parent
 *   repos                          -> repos
 *   owner, claimed_at              -> claimed-by, claimed-at
 *   x-rank                         -> rank
 *   x-worker x-persona x-track     -> worker persona track
 *   x-form x-proof x-awaiting      -> form proof awaiting
 *   x-interactive                  -> interactive          ("true")
 *   x-chain                        -> chain                (entries separated by `;`)
 *   x-references                   -> references           (separated by `,`)
 *   x-entered-<phase>              -> entered-<phase>
 *
 * Not carried: `branch` (the rule `t/<id>` wins in the reader anyway), `run`
 * (the runner's process table, not ticket data), `parked-*` (a parked ticket
 * is stage `blocked`, migration plan §3), labels / kind / size / epoch / rev /
 * lease (dricket data the legacy board has no field for).
 */

/** Drey keys that ride in an `x-` extension field, in header order. */
export const EXTENSION_KEYS = ['worker', 'persona', 'track', 'form', 'proof', 'awaiting'] as const;

export interface RecordsBoardInput extends Omit<AssembleInput, 'files'> {
  readonly records: readonly TicketDetail[];
}

export interface PhaseResolution {
  readonly phase: string;
  /** True when the stage matched no pipeline phase and stays as it is (an unknown column). */
  readonly unmapped: boolean;
}

/**
 * Which pipeline column a record belongs to.
 *
 *  1. `x-phase` when it names a pipeline phase (variant B of the migration plan:
 *     dricket's built-in stages with the phase kept beside them);
 *  2. the stage itself when it is a pipeline phase id (variant A: `[stages]` in
 *     `dricket.toml` lists the phase ids — the preferred setup);
 *  3. dricket's built-in stage names, by role: `open` / `blocked` -> the capture
 *     column, `in-progress` -> the first claiming column, `review` -> `commit`
 *     (else the column before the terminal one), `done` / `cancelled` -> the
 *     terminal column;
 *  4. otherwise the raw stage: the board shows it as an unknown column with a
 *     warning, exactly like a stray directory.
 */
export function resolvePhase(record: TicketDetail, phases: readonly PipelinePhase[]): PhaseResolution {
  const ids = phases.map((p) => p.id);
  const pinned = record.extensions['x-phase'];
  if (pinned !== undefined && ids.includes(pinned)) {
    return { phase: pinned, unmapped: false };
  }
  if (ids.includes(record.stage)) {
    return { phase: record.stage, unmapped: false };
  }
  const first = ids[0];
  const last = ids[ids.length - 1];
  let role: string | undefined;
  switch (record.stage) {
    case 'open':
    case 'blocked':
      role = first;
      break;
    case 'in-progress':
      role = phases.find((p) => p.claim)?.id ?? ids[1];
      break;
    case 'review':
      role = ids.includes('commit') ? 'commit' : ids.length >= 3 ? ids[ids.length - 2] : undefined;
      break;
    case 'done':
    case 'cancelled':
      role = last;
      break;
    default:
      role = undefined;
  }
  return role === undefined ? { phase: record.stage, unmapped: true } : { phase: role, unmapped: false };
}

/** One record as the legacy ticket file the board reader understands. */
export function recordToBoardFile(record: TicketDetail, phase: string): BoardFile {
  const x = record.extensions;
  const header: Record<string, unknown> = { id: record.id, title: record.title };
  if (record.repos.length > 0) {
    header['repos'] = [...record.repos];
  }
  if (record.priority !== null) {
    header['priority'] = record.priority;
  }
  const rank = x['x-rank'];
  if (rank !== undefined && rank !== '') {
    header['rank'] = /^\d+$/.test(rank) ? Number(rank) : rank;
  }
  for (const key of EXTENSION_KEYS) {
    const value = x[`x-${key}`];
    if (value !== undefined && value !== '') {
      header[key] = value;
    }
  }
  if (x['x-interactive'] === 'true') {
    header['interactive'] = true;
  }
  const chain = splitOn(x['x-chain'], ';');
  if (chain.length > 0) {
    header['chain'] = chain;
  }
  const references = splitOn(x['x-references'], ',');
  if (references.length > 0) {
    header['references'] = references;
  }
  if (record.dependsOn.length > 0) {
    header['blocked-by'] = [...record.dependsOn];
  }
  if (record.owner !== null) {
    header['claimed-by'] = record.owner;
    if (record.claimedAt !== null) {
      header['claimed-at'] = record.claimedAt;
    }
  }
  if (record.parent !== null) {
    header['parent'] = record.parent;
  }
  for (const [key, value] of Object.entries(x)) {
    const entered = /^x-entered-([a-z][a-z0-9-]*)$/.exec(key);
    if (entered !== null && value !== '') {
      header[`entered-${entered[1]}`] = value;
    }
  }
  const yaml = stringify(header, { lineWidth: 0 });
  return { path: `tickets/${phase}/${record.id}.md`, text: `---\n${yaml}---\n${record.body}` };
}

function splitOn(value: string | undefined, separator: string): string[] {
  return value === undefined
    ? []
    : value
        .split(separator)
        .map((s) => s.trim())
        .filter((s) => s !== '');
}

/**
 * The board snapshot from store records. Same pipeline / repos / ledger inputs
 * as the file path (those stay in the meta vault); only the tickets differ.
 * A record whose stage matches no column is shown in an unknown column — the
 * assembler's existing "directory is not a phase" warning covers it.
 */
export function assembleBoardFromRecords(input: RecordsBoardInput): BoardSnapshot {
  // The phases are needed to place records, and are parsed by `assembleBoard`
  // later anyway; a first assembly with no tickets gives them without a second parser.
  const probe = assembleBoard({ ...input, files: [], recentDone: [] });
  const files = input.records.map((record) => {
    const { phase } = resolvePhase(record, probe.pipeline);
    return recordToBoardFile(record, phase);
  });
  return assembleBoard({ ...input, files });
}
