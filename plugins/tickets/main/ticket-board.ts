/**
 * Pure board assembly (ADR-0076): parses the `_meta` configuration,
 * orders columns (derived order + sparse pins), and folds parsed
 * tickets into a snapshot shape. No IO — `index.ts` feeds it files and
 * paths, the specs feed it fixtures. Everything here is deterministic:
 * the same files always produce the same board (no stored state).
 */
import { parseDocument } from 'yaml';
import { splitFrontmatter } from '../../../shared/frontmatter';
import {
  priorityWeight,
  type BoardColumn,
  type BoardSnapshot,
  type PipelinePhase,
  type RepoRef,
  type TicketCard,
  type TicketIssue,
  type TicketPriority,
} from '../shared/tickets';
import { parseTicketFile, ticketPathParts } from './ticket-files';

const PHASE_ID = /^[a-z][a-z0-9-]*$/;

// --- pipeline.md -----------------------------------------------------------

export interface PipelineParse {
  readonly phases: readonly PipelinePhase[];
  readonly error: string | null;
}

export function parsePipeline(text: string): PipelineParse {
  const { yamlText, hadFence } = splitFrontmatter(text);
  if (!hadFence || yamlText === null) {
    return { phases: [], error: 'pipeline.md has no frontmatter fence' };
  }
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    return { phases: [], error: `pipeline.md does not parse: ${doc.errors[0]!.message}` };
  }
  const parsed = doc.toJS() as unknown;
  const root = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
  const rawPhases = root['phases'];
  if (!Array.isArray(rawPhases) || rawPhases.length === 0) {
    return { phases: [], error: 'pipeline.md needs a non-empty phases list' };
  }

  const phases: PipelinePhase[] = [];
  const seen = new Set<string>();
  for (const entry of rawPhases) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { phases: [], error: 'every pipeline phase must be a mapping' };
    }
    const map = entry as Record<string, unknown>;
    const id = typeof map['id'] === 'string' ? map['id'] : '';
    if (!PHASE_ID.test(id)) {
      return { phases: [], error: `phase id "${id}" must match ${PHASE_ID.source}` };
    }
    if (seen.has(id)) {
      return { phases: [], error: `duplicate phase id "${id}"` };
    }
    seen.add(id);
    const wipRaw = map['wip'];
    const wip = typeof wipRaw === 'number' && Number.isInteger(wipRaw) && wipRaw > 0 ? wipRaw : null;
    phases.push({
      id,
      title: typeof map['title'] === 'string' && map['title'].trim() !== '' ? map['title'] : id,
      wip,
      claim: map['claim'] === true,
      handover: typeof map['handover'] === 'string' && map['handover'].trim() !== '' ? map['handover'] : 'manual',
    });
  }
  return { phases, error: null };
}

// --- order.md --------------------------------------------------------------

export interface OrderParse {
  readonly pins: Readonly<Record<string, readonly string[]>>;
  readonly issues: readonly TicketIssue[];
}

/** Sections are `## <phase>` + `- <id>` lines; everything else is prose. */
export function parseOrderFile(text: string | null): OrderParse {
  if (text === null) {
    return { pins: {}, issues: [] };
  }
  const pins: Record<string, string[]> = {};
  const issues: TicketIssue[] = [];
  let section: string | null = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      section = PHASE_ID.test(heading[1]!) ? heading[1]! : null;
      if (section !== null && pins[section] === undefined) {
        pins[section] = [];
      } else if (section === null) {
        issues.push({ level: 'noise', message: `order.md ignores section "${heading[1]}"` });
      }
      continue;
    }
    const item = /^-\s+(T-\d{4,})\s*$/.exec(line);
    if (item !== null && section !== null) {
      pins[section]!.push(item[1]!);
    }
  }
  return { pins, issues };
}

/** Rewrites (or adds) one section, preserving every other line verbatim. */
export function rewriteOrderSection(text: string, phase: string, ids: readonly string[]): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inSection = false;
  let wrote = false;
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line.trim());
    if (heading !== null) {
      if (inSection) {
        inSection = false;
      }
      if (heading[1] === phase) {
        inSection = true;
        wrote = true;
        out.push(line);
        for (const id of ids) {
          out.push(`- ${id}`);
        }
        out.push('');
        continue;
      }
    } else if (inSection && line.trim() === '') {
      // Skip the old section body's blank separators; the rewrite adds its own.
      if (out.length > 0 && out[out.length - 1] === '') {
        continue;
      }
    } else if (inSection) {
      continue; // Drop the old pinned list.
    }
    out.push(line);
  }
  if (!wrote) {
    while (out.length > 0 && out[out.length - 1]!.trim() === '') {
      out.pop();
    }
    out.push('', `## ${phase}`, '');
    for (const id of ids) {
      out.push(`- ${id}`);
    }
    out.push('');
  }
  let result = out.join('\n');
  if (!result.endsWith('\n')) {
    result += '\n';
  }
  return result;
}

// --- repos.md --------------------------------------------------------------

export interface ReposParse {
  readonly repos: readonly RepoRef[];
  readonly error: string | null;
}

export function parseRepos(text: string | null): ReposParse {
  if (text === null) {
    return { repos: [], error: null };
  }
  const { yamlText, hadFence } = splitFrontmatter(text);
  if (!hadFence || yamlText === null) {
    return { repos: [], error: 'repos.md has no frontmatter fence' };
  }
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    return { repos: [], error: `repos.md does not parse: ${doc.errors[0]!.message}` };
  }
  const parsed = doc.toJS() as unknown;
  const root = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
  const rawRepos = root['repos'];
  if (rawRepos === undefined || rawRepos === null) {
    return { repos: [], error: 'repos.md needs a repos mapping' };
  }
  if (typeof rawRepos !== 'object' || Array.isArray(rawRepos)) {
    return { repos: [], error: 'repos.md: repos must be a mapping of name -> {url, branch, policy}' };
  }
  const repos: RepoRef[] = [];
  for (const [name, entry] of Object.entries(rawRepos as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { repos: [], error: `repos.md: repo "${name}" must be a mapping` };
    }
    const map = entry as Record<string, unknown>;
    const url = typeof map['url'] === 'string' ? map['url'].trim() : '';
    if (url === '') {
      return { repos: [], error: `repos.md: repo "${name}" needs a url` };
    }
    repos.push({
      name,
      url,
      branch: typeof map['branch'] === 'string' && map['branch'].trim() !== '' ? map['branch'] : null,
      policy: typeof map['policy'] === 'string' && map['policy'].trim() !== '' ? map['policy'] : null,
      path: typeof map['path'] === 'string' && map['path'].trim() !== '' ? map['path'].trim() : null,
    });
  }
  return { repos, error: null };
}

// --- ordering ----------------------------------------------------------------

/** The comparison projection of a ticket for derived ordering. */
export interface OrderKey {
  readonly id: string;
  readonly priority: TicketPriority;
  readonly rank: number;
  /** The `entered-<phase>` stamp of the column being ordered ('' when none). */
  readonly entered: string;
}

/** Derived order: priority, then rank, then `entered-<phase>`, then id. */
export function derivedOrder(keys: readonly OrderKey[]): OrderKey[] {
  return [...keys].sort((a, b) => {
    const pri = priorityWeight(a.priority) - priorityWeight(b.priority);
    if (pri !== 0) {
      return pri;
    }
    if (a.rank !== b.rank) {
      return a.rank - b.rank;
    }
    if (a.entered !== b.entered) {
      return a.entered === '' ? 1 : b.entered === '' ? -1 : a.entered < b.entered ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Final column order: pinned ids (listed order) first, then derived. */
export function orderColumn<T extends { readonly id: string }>(
  tickets: readonly T[],
  pins: readonly string[] | undefined,
  keyOf: (ticket: T) => OrderKey,
): T[] {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const head: T[] = [];
  if (pins !== undefined) {
    for (const id of pins) {
      const card = byId.get(id);
      if (card !== undefined) {
        head.push(card);
        byId.delete(id);
      }
    }
  }
  // Keys were built from byId itself, so every lookup lands.
  const rest = derivedOrder([...byId.values()].map(keyOf)).map((k) => byId.get(k.id) as T);
  return [...head, ...rest];
}

/**
 * The pin list after a drag to `dropIndex`: everything above and
 * including the drop position becomes the column's pinned queue
 * (spec: "a drag pins the cards above and including the drop
 * position"). Dropping at the bottom pins the whole column.
 */
export function pinsAfterDrop(order: readonly string[], dropIndex: number): string[] {
  const clamped = Math.max(0, Math.min(dropIndex, order.length - 1));
  return order.slice(0, clamped + 1);
}

/**
 * The resulting order of a column after a move-within / move-into drop,
 * BEFORE pin trimming — the renderer computes it to call
 * `pinsAfterDrop` on it.
 */
export function orderAfterInsert(
  currentOrder: readonly string[],
  movedId: string,
  dropIndex: number,
): string[] {
  const without = currentOrder.filter((id) => id !== movedId);
  const clamped = Math.max(0, Math.min(dropIndex, without.length));
  return [...without.slice(0, clamped), movedId, ...without.slice(clamped)];
}

// --- snapshot assembly --------------------------------------------------------

export interface BoardFile {
  /** Vault-relative path of a `tickets/<dir>/<name>.md` file. */
  readonly path: string;
  readonly text: string;
}

export interface AssembleInput {
  readonly vaultId: string | null;
  readonly vaultName: string | null;
  readonly activeVaultName: string | null;
  readonly isGitRepo: boolean;
  readonly pipelineText: string | null;
  readonly orderText: string | null;
  readonly reposText: string | null;
  readonly files: readonly BoardFile[];
}

/** Files under `tickets/` that are neither `_meta` nor ticket-shaped. */
function strayFileIssue(path: string): TicketIssue {
  return { level: 'noise', message: `unexpected file in the tickets tree: ${path}` };
}

export function assembleBoard(input: AssembleInput): BoardSnapshot {
  const issues: TicketIssue[] = [];

  const pipelineParse = input.pipelineText === null
    ? { phases: [], error: 'tickets/_meta/pipeline.md is missing' }
    : parsePipeline(input.pipelineText);
  if (pipelineParse.error !== null) {
    issues.push({ level: 'error', message: pipelineParse.error });
  }
  const phases = pipelineParse.phases;
  const phaseIds = new Set(phases.map((p) => p.id));

  const orderParse = parseOrderFile(input.orderText);
  for (const issue of orderParse.issues) {
    issues.push({ level: issue.level, message: `order.md: ${issue.message}` });
  }
  for (const [section, ids] of Object.entries(orderParse.pins)) {
    if (!phaseIds.has(section)) {
      issues.push({ level: 'noise', message: `order.md pins unknown phase "${section}"` });
    }
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length > 0) {
      issues.push({ level: 'noise', message: `order.md: duplicate pins in "${section}" ignored` });
    }
  }

  const reposParse = parseRepos(input.reposText);
  if (reposParse.error !== null) {
    issues.push({ level: 'error', message: reposParse.error });
  }
  const repoNames = new Set(reposParse.repos.map((r) => r.name));

  // Parse every ticket; group by directory. Cards stay mutable through
  // the duplicate pass, then flow into columns as-is (structural match).
  interface AssemblyCard extends TicketCard {
    issues: TicketIssue[];
  }
  const byPhase = new Map<string, AssemblyCard[]>();
  for (const file of input.files) {
    const parts = ticketPathParts(file.path);
    if (parts === null) {
      // `_meta` holds the board's configuration, not tickets — only
      // genuinely stray files get the badge.
      if (!file.path.startsWith('tickets/_meta/')) {
        issues.push(strayFileIssue(file.path));
      }
      continue;
    }
    if (parts.phase === '_meta') {
      continue; // a ticket-stemmed file inside _meta: ignore, don't column it.
    }
    const parsed = parseTicketFile(file.text, file.path);
    if (parsed.meta.repo !== null && !repoNames.has(parsed.meta.repo)) {
      parsed.issues.push({ level: 'warning', message: `repo "${parsed.meta.repo}" is not in _meta/repos.md` });
    }
    if (parsed.meta.parkedReason !== null && parts.phase !== 'inbox') {
      parsed.issues.push({ level: 'noise', message: 'parked ticket outside inbox — the fields are ignored here' });
    }
    const card: AssemblyCard = {
      id: parts.stem,
      path: file.path,
      phase: parts.phase,
      meta: parsed.meta,
      pinned: (orderParse.pins[parts.phase] ?? []).includes(parts.stem),
      issues: [...parsed.issues],
    };
    const list = byPhase.get(parts.phase) ?? [];
    list.push(card);
    byPhase.set(parts.phase, list);
  }

  // An id in more than one phase is ambiguous — every occurrence carries
  // the badge (which file is the stray one is not for us to guess).
  const idCounts = new Map<string, number>();
  for (const cards of byPhase.values()) {
    for (const card of cards) {
      idCounts.set(card.id, (idCounts.get(card.id) ?? 0) + 1);
    }
  }
  for (const [id, count] of idCounts) {
    if (count > 1) {
      for (const cards of byPhase.values()) {
        for (const card of cards) {
          if (card.id === id) {
            card.issues.unshift({ level: 'error', message: 'id exists in more than one phase' });
          }
        }
      }
    }
  }

  // Columns: configured phases in order, then unknown directories.
  const columnKey = (phase: string) => (card: TicketCard): OrderKey => ({
    id: card.id,
    priority: card.meta.priority,
    rank: card.meta.rank,
    entered: card.meta.entered[phase] ?? '',
  });
  const columns: BoardColumn[] = phases.map((phase) => {
    const tickets = byPhase.get(phase.id) ?? [];
    return {
      phase,
      unknown: false,
      tickets: orderColumn(tickets, orderParse.pins[phase.id], columnKey(phase.id)),
    };
  });
  const knownDirs = new Set([...phaseIds, '_meta']);
  for (const dir of [...byPhase.keys()].sort()) {
    if (!knownDirs.has(dir)) {
      issues.push({ level: 'warning', message: `directory "${dir}" is not a phase in pipeline.md` });
      columns.push({
        phase: { id: dir, title: dir, wip: null, claim: false, handover: 'manual' },
        unknown: true,
        tickets: orderColumn(byPhase.get(dir)!, orderParse.pins[dir], columnKey(dir)),
      });
    }
  }

  return {
    vaultId: input.vaultId,
    vaultName: input.vaultName,
    activeVaultName: input.activeVaultName,
    isGitRepo: input.isGitRepo,
    pipeline: phases,
    pipelineError: pipelineParse.error,
    repos: reposParse.repos,
    reposError: reposParse.error,
    columns,
    issues,
  };
}
