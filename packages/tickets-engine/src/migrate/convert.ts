import { CLAIM_STATE_IDS, LEGACY_PHASE_STATES, stateOfPhase, STATE_IDS } from '../core/pipeline-states';
import { toDricketId } from '../store/ids';
import { ARCHIVED_LABEL } from '../store/legacy-bridge';
import { ticketNumber, type LegacyTicket, type LegacyVault } from './legacy-vault';

/**
 * Legacy ticket -> dricket ticket (E14-3, migration-plan §3). Pure: no file,
 * no process. The converter decides WHAT the target looks like; `apply.ts`
 * lets `dk` write it, `reverse.ts` goes the other way.
 *
 * Rules that matter (everything else is in the table of the plan):
 * - the body is carried byte for byte, header keys are rewritten;
 * - a legacy phase is the dricket stage (variant A, R-03 shipped);
 * - Drey-only header keys become `x-` fields (R-01); a value `x-` cannot hold
 *   (a nested map) is dropped and REPORTED, never silently lost;
 * - creation time and creator become the ticket's own `created_at` /
 *   `created_by` (the apply writes the files itself, E14-3b).
 */

export interface MigrationConfig {
  /** The configured `[stages]` values, in board order. */
  readonly stages: readonly string[];
  /** The configured `claim` stages: the agent columns (E12-9c). */
  readonly claim: readonly string[];
  /**
   * Legacy phase -> stage, for a phase that is not a stage id itself (req-99a, the mapping of O-2):
   * `plan` -> `shaping`, `build` -> `building`, `review` / `sign-off` / `commit` -> `ready`.
   */
  readonly legacyPhases: Readonly<Record<string, string>>;
  /** The configured priority values; the first match of the legacy value wins. */
  readonly priorities: readonly string[];
  readonly defaultPriority: string;
  /** The ids to migrate (the owner's triage list). */
  readonly selected: readonly string[];
  /** dk title limit. */
  readonly maxTitleLength: number;
  /**
   * Migrate the legacy rchive/ too (rehearsal 2026-11-06): each becomes a ticket in the terminal stage
   * carrying the rchived label, which keeps it off the board while dk ls / dk show / search read it.
   * Off by default (OD-7).
   */
  readonly includeArchive?: boolean;
}

export const DEFAULT_MIGRATION_CONFIG: Omit<MigrationConfig, 'selected'> = {
  stages: [...STATE_IDS],
  claim: CLAIM_STATE_IDS,
  legacyPhases: LEGACY_PHASE_STATES,
  priorities: ['urgent', 'high', 'normal', 'low'],
  defaultPriority: 'normal',
  maxTitleLength: 200,
};

/** The stage a legacy phase lands in: the phase itself when it is a stage, else the configured mapping, else null. */
export function stageOfLegacyPhase(phase: string, config: Pick<MigrationConfig, 'stages' | 'legacyPhases'>): string | null {
  return stateOfPhase(phase, config.stages, config.legacyPhases);
}

/** Header keys that never travel: live execution state (the cut-over requires none). */
const LIVE_STATE_KEYS: ReadonlySet<string> = new Set(['claimed-by', 'claimed-at', 'run']);

/** Keys that become typed dricket fields (everything else is an `x-` field). */
const MAPPED_KEYS: ReadonlySet<string> = new Set(['id', 'title', 'repo', 'repos', 'priority', 'branch', 'blocked-by', 'parent']);

/** `chain` is `;`-separated, every other list `, `-separated (plan §3). */
const SEMICOLON_LISTS: ReadonlySet<string> = new Set(['chain']);

/** Keys whose raw value is restored with a type by the reverse converter. */
export const NUMERIC_KEYS: ReadonlySet<string> = new Set(['rank']);
export const BOOLEAN_KEYS: ReadonlySet<string> = new Set(['interactive']);
export const LIST_KEYS: ReadonlySet<string> = new Set(['chain', 'references']);

export interface TargetTicket {
  /** Display id `T-0063`. */
  readonly legacyId: string;
  /** dricket id `t-63`. */
  readonly id: string;
  readonly number: number;
  readonly stage: string;
  readonly title: string;
  readonly priority: string;
  readonly kind: 'human' | 'agent';
  /** Legacy creation stamp / creator (null = unknown): written as `created_at` / `created_by`. */
  readonly createdAt: string | null;
  readonly createdBy: string | null;
  readonly labels: readonly string[];
  /** dricket ids. */
  readonly depends: readonly string[];
  readonly parent: string | null;
  readonly branch: string | null;
  readonly repos: readonly string[];
  /** `x-` fields in write order. */
  readonly extensions: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface DroppedField {
  readonly key: string;
  readonly reason: string;
}

export type ConversionStatus = 'migrate' | 'skip';

export interface TicketConversion {
  readonly legacyId: string;
  readonly phase: string;
  readonly status: ConversionStatus;
  readonly skipReason: string | null;
  /** Reasons the apply refuses this ticket unless told otherwise (a live run stamp). */
  readonly blocking: readonly string[];
  readonly target: TargetTicket | null;
  readonly warnings: readonly string[];
  readonly dropped: readonly DroppedField[];
}

export interface ConversionPlan {
  readonly conversions: readonly TicketConversion[];
  /** Allow-list ids that no file in the vault carries. */
  readonly missingSelected: readonly string[];
  readonly unreadable: LegacyVault['unreadable'];
}

// ---------------------------------------------------------------------------

export function buildPlan(vault: LegacyVault, config: MigrationConfig): ConversionPlan {
  const byId = new Map(vault.tickets.map((t) => [t.id, t] as const));
  const missingSelected = config.selected.filter((id) => !byId.has(id));

  // First pass: which selected tickets can migrate at all (dangling-reference rule needs the set).
  const migrating = new Set<string>();
  for (const id of config.selected) {
    const t = byId.get(id);
    if (t !== undefined && skipReasonOf(t, config) === null) {
      migrating.add(id);
    }
  }

  const conversions: TicketConversion[] = [];
  for (const id of config.selected) {
    const t = byId.get(id);
    if (t === undefined) {
      continue;
    }
    conversions.push(convertTicket(t, config, migrating));
  }
  conversions.sort((a, b) => ticketNumber(a.legacyId) - ticketNumber(b.legacyId));

  return { conversions, missingSelected, unreadable: vault.unreadable };
}

function skipReasonOf(t: LegacyTicket, config: MigrationConfig): string | null {
  if (t.phase === 'archive') {
    return config.includeArchive === true ? null : 'archived in the legacy vault; archived tickets are not migrated (OD-7)';
  }
  if (stageOfLegacyPhase(t.phase, config) === null) {
    return `phase "${t.phase}" is not one of the configured stages (${config.stages.join(', ')})`;
  }
  if (toDricketId(t.id) === null) {
    return `"${t.id}" has no dricket id`;
  }
  return null;
}

/** Convert one ticket. `migrating` is the set of legacy ids that will exist in the store. */
export function convertTicket(t: LegacyTicket, config: MigrationConfig, migrating: ReadonlySet<string>): TicketConversion {
  const skip = skipReasonOf(t, config);
  if (skip !== null) {
    return { legacyId: t.id, phase: t.phase, status: 'skip', skipReason: skip, blocking: [], target: null, warnings: [], dropped: [] };
  }

  const h = t.header;
  const warnings: string[] = [...t.issues];
  const dropped: DroppedField[] = [];
  const blocking: string[] = [];
  const extensions: Record<string, string> = {};

  // --- identity ----------------------------------------------------------
  const id = toDricketId(t.id)!;
  extensions['x-legacy-id'] = t.id;
  extensions['x-legacy-phase'] = t.phase;

  // --- title -------------------------------------------------------------
  let body = t.body;
  let title = flatten(h['title']) ?? '';
  if (title === '') {
    title = t.id;
    warnings.push('title is missing; the id is used as the title');
  }
  if (title.length > config.maxTitleLength) {
    const cut = title.slice(0, config.maxTitleLength - 1).trimEnd() + '…';
    warnings.push(`title is ${title.length} characters (limit ${config.maxTitleLength}); shortened, the full title is prepended to the description`);
    body = prependFullTitle(body, title);
    title = cut;
  }

  // --- priority ----------------------------------------------------------
  const rawPriority = flatten(h['priority']);
  let priority = config.defaultPriority;
  if (rawPriority !== null) {
    if (config.priorities.includes(rawPriority)) {
      priority = rawPriority;
    } else {
      warnings.push(`priority "${rawPriority}" is not configured; "${config.defaultPriority}" is used`);
      extensions['x-legacy-priority'] = rawPriority;
    }
  }

  // --- creation data -----------------------------------------------------
  const log = firstLogEntry(t.body);
  const enteredFirst = firstEntered(h);
  const createdAt = enteredFirst ?? log?.stamp ?? null;
  const createdBy = log?.actor ?? null;
  if (createdAt === null) {
    warnings.push('no creation time (no entered-* stamp, no Log line); the apply time is used');
  }
  if (createdBy === null) {
    warnings.push('no creator (no Log line); the migrating identity is used');
  }
  const kind: 'human' | 'agent' = createdBy !== null && createdBy.startsWith('owner@') ? 'human' : 'agent';

  // --- repos / branch ----------------------------------------------------
  const listedRepos = asStringList(h['repos']);
  const repoKey = flatten(h['repo']);
  const orderedRepos = listedRepos.length > 0 ? listedRepos : repoKey !== null ? [repoKey] : [];
  if (listedRepos.length > 0 && repoKey !== null && repoKey !== listedRepos[0]) {
    warnings.push(`repo "${repoKey}" differs from repos[0] "${listedRepos[0]}"; repos wins (as in the board)`);
  }
  const branch = flatten(h['branch']);

  // --- blocked-by / parent -----------------------------------------------
  const depends: string[] = [];
  const blockedBy = asStringList(h['blocked-by']);
  const removed: string[] = [];
  for (const b of blockedBy) {
    const mapped = toDricketId(b);
    if (mapped !== null && migrating.has(b) && b !== t.id) {
      depends.push(mapped);
    } else {
      removed.push(b);
    }
  }
  if (removed.length > 0) {
    extensions['x-legacy-blocked-by'] = blockedBy.join(', ');
    warnings.push(`blocked-by ${removed.join(', ')} not in the migrated set; removed from depends (kept in x-legacy-blocked-by)`);
  }
  let parent: string | null = null;
  const rawParent = flatten(h['parent']);
  if (rawParent !== null) {
    const mapped = toDricketId(rawParent);
    if (mapped !== null && migrating.has(rawParent)) {
      parent = mapped;
    } else {
      extensions['x-legacy-parent'] = rawParent;
      warnings.push(`parent ${rawParent} is not in the migrated set; kept in x-legacy-parent`);
    }
  }

  // --- the rest of the header --------------------------------------------
  for (const [key, value] of Object.entries(h)) {
    if (MAPPED_KEYS.has(key)) {
      continue;
    }
    if (LIVE_STATE_KEYS.has(key)) {
      dropped.push({ key, reason: 'live execution state is not migrated' });
      if (key === 'run') {
        blocking.push('a run stamp is present: a run may still be live (the cut-over requires none)');
      } else if (key === 'claimed-by' && t.phase === 'build') { // a legacy phase id: this reads the old vault
        blocking.push('claimed in build: the cut-over requires no live claim');
      }
      continue;
    }
    const entered = /^entered-([a-z][a-z0-9-]*)$/.exec(key);
    const ext = entered !== null ? `x-entered-${entered[1]}` : extensionName(key);
    if (ext === null) {
      dropped.push({ key, reason: 'not a valid x- field name' });
      continue;
    }
    const flat = flattenExtension(key, value);
    if (flat === null) {
      dropped.push({ key, reason: 'structured value an x- field cannot hold' });
      continue;
    }
    if (flat === '') {
      continue;
    }
    extensions[ext] = flat;
  }

  // --- links to attachments ----------------------------------------------
  const rewritten = rewriteAttachmentLinks(body);
  if (rewritten.count > 0) {
    warnings.push(`${rewritten.count} attachment link(s) rewritten from ../attachments/ to attachments/`);
    body = rewritten.text;
  }

  if (extensions['x-rank'] === undefined) {
    warnings.push('no rank; the board orders it by id');
  }

  return {
    legacyId: t.id,
    phase: t.phase,
    status: 'migrate',
    skipReason: null,
    blocking,
    target: {
      legacyId: t.id,
      id,
      number: ticketNumber(t.id),
      stage: t.phase === 'archive' ? config.stages[config.stages.length - 1]! : stageOfLegacyPhase(t.phase, config)!,
      title,
      priority,
      kind,
      createdAt,
      createdBy,
      labels: t.phase === 'archive' ? [ARCHIVED_LABEL] : [],
      depends,
      parent,
      branch,
      repos: orderedRepos,
      extensions,
      body,
    },
    warnings,
    dropped,
  };
}

// ---------------------------------------------------------------------------
// Helpers

function extensionName(key: string): string | null {
  return /^[a-z][a-z0-9-]*$/.test(key) ? `x-${key}` : null;
}

/** A scalar as one line of text; null for undefined/null/empty. */
export function flatten(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    // eslint-disable-next-line no-control-regex
    const one = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\s*\r?\n\s*/g, ' ').trim();
    return one === '' ? null : one;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function flattenExtension(key: string, value: unknown): string | null {
  if (Array.isArray(value)) {
    const parts = value.map((v) => flatten(v));
    if (parts.some((p) => p === null)) {
      return null;
    }
    return (parts as string[]).join(SEMICOLON_LISTS.has(key) ? '; ' : ', ');
  }
  if (value !== null && typeof value === 'object') {
    return null;
  }
  return flatten(value) ?? '';
}

export function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => flatten(v)).filter((v): v is string => v !== null);
  }
  const one = flatten(value);
  return one === null ? [] : [one];
}

function firstEntered(h: Readonly<Record<string, unknown>>): string | null {
  const inbox = flatten(h['entered-inbox']);
  if (inbox !== null) {
    return inbox;
  }
  const stamps = Object.entries(h)
    .filter(([k]) => k.startsWith('entered-'))
    .map(([, v]) => flatten(v))
    .filter((v): v is string => v !== null)
    .sort();
  return stamps[0] ?? null;
}

const LOG_LINE = /^- '?(\d{4}-\d\d-\d\dT[\d:.]+Z)'? (\S+) —/m;

export function firstLogEntry(body: string): { stamp: string; actor: string } | null {
  const m = LOG_LINE.exec(body);
  return m === null ? null : { stamp: m[1]!, actor: m[2]!.split(':')[0]! };
}

function prependFullTitle(body: string, fullTitle: string): string {
  const marker = /^## Description[ \t]*$/m.exec(body);
  const note = `Full title: ${fullTitle}\n\n`;
  if (marker === null) {
    return `\n${note}${body.replace(/^\r?\n/, '')}`;
  }
  const at = marker.index + marker[0].length;
  const rest = body.slice(at).replace(/^\n+/, '');
  return `${body.slice(0, at)}\n\n${note}${rest}`;
}

export function rewriteAttachmentLinks(text: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(/\]\(\.\.\/attachments\//g, () => {
    count += 1;
    return '](attachments/';
  });
  return { text: out, count };
}
