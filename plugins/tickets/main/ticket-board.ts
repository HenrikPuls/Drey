/**
 * Pure board assembly (ADR-0076): parses the `_meta` configuration,
 * orders columns (derived order + sparse pins), and folds parsed
 * tickets into a snapshot shape. No IO — `index.ts` feeds it files and
 * paths, the specs feed it fixtures. Everything here is deterministic:
 * the same files always produce the same board (no stored state).
 */
import { isCollection, isMap, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml';
import { splitFrontmatter } from '../../../shared/frontmatter';
import {
  parseHandover,
  priorityWeight,
  phaseWithoutPoolKeys,
  resolveCardWorker,
  TICKETS_ARCHIVE_DIR,
  type BoardColumn,
  type BoardSnapshot,
  type PipelinePhase,
  type RepoRef,
  type TicketCard,
  type TicketIssue,
  type TicketPriority,
} from '../shared/tickets';
import { checkpointPhaseIds } from './fleet/chain';
import { runDependencyPass } from './blocked';
import { parseTicketFile, ticketPathParts } from './ticket-files';

const PHASE_ID = /^[a-z][a-z0-9-]*$/;

// --- pipeline.md -----------------------------------------------------------

export interface PipelineParse {
  readonly phases: readonly PipelinePhase[];
  /** The optional top-level `push:` remote (T-0041); null = never push. */
  readonly pushRemote: string | null;
  readonly error: string | null;
  /** Noise findings the parse forgave (a non-string `push:`). */
  readonly issues: readonly TicketIssue[];
}

export function parsePipeline(text: string): PipelineParse {
  const { yamlText, hadFence } = splitFrontmatter(text);
  if (!hadFence || yamlText === null) {
    return { phases: [], pushRemote: null, error: 'pipeline.md has no frontmatter fence', issues: [] };
  }
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    return { phases: [], pushRemote: null, error: `pipeline.md does not parse: ${doc.errors[0]!.message}`, issues: [] };
  }
  const parsed = doc.toJS() as unknown;
  const root = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
  const rawPhases = root['phases'];
  if (!Array.isArray(rawPhases) || rawPhases.length === 0) {
    return { phases: [], pushRemote: null, error: 'pipeline.md needs a non-empty phases list', issues: [] };
  }

  const issues: TicketIssue[] = [];
  const rawPush = root['push'];
  let pushRemote: string | null = null;
  if (rawPush !== undefined && rawPush !== null) {
    if (typeof rawPush === 'string' && rawPush.trim() !== '') {
      pushRemote = rawPush.trim();
    } else {
      // A remote NAME belongs here (git config owns URLs); anything else is forgiven visibly.
      issues.push({ level: 'noise', message: 'pipeline.md: push must be a remote name string — ignored' });
    }
  }

  const phases: PipelinePhase[] = [];
  const seen = new Set<string>();
  for (const entry of rawPhases) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { phases: [], pushRemote: null, error: 'every pipeline phase must be a mapping', issues };
    }
    const map = entry as Record<string, unknown>;
    const id = typeof map['id'] === 'string' ? map['id'] : '';
    if (!PHASE_ID.test(id)) {
      return { phases: [], pushRemote: null, error: `phase id "${id}" must match ${PHASE_ID.source}`, issues };
    }
    if (seen.has(id)) {
      return { phases: [], pushRemote: null, error: `duplicate phase id "${id}"`, issues };
    }
    seen.add(id);
    const wipRaw = map['wip'];
    const wip = typeof wipRaw === 'number' && Number.isInteger(wipRaw) && wipRaw > 0 ? wipRaw : null;
    const workerRaw = map['worker'];
    const worker = typeof workerRaw === 'string' && workerRaw.trim() !== '' ? workerRaw.trim() : null;
    const modelRaw = map['model'];
    const model = typeof modelRaw === 'string' && modelRaw.trim() !== '' ? modelRaw.trim() : null;
    if (map['workers'] !== undefined) {
      // req-63: the pools belong to the providers now — the old column key is forgiven visibly.
      issues.push({
        level: 'noise',
        message: `pipeline.md: ${id}'s workers: is no longer read — set the pool size in Settings → Tickets → Workers`,
      });
    }
    const promptRaw = map['prompt'];
    const prompt = typeof promptRaw === 'string' && promptRaw.trim() !== '' ? promptRaw.trim() : null;
    const interactiveRaw = map['interactive'];
    const interactive =
      typeof interactiveRaw === 'string' && interactiveRaw.trim() !== '' ? interactiveRaw.trim() : null;
    const maxRedRaw = map['max-red'];
    const maxRed = typeof maxRedRaw === 'number' && Number.isInteger(maxRedRaw) && maxRedRaw > 0 ? maxRedRaw : null;
    const tokenBudgetRaw = map['token-budget'];
    const tokenBudget =
      typeof tokenBudgetRaw === 'number' && Number.isFinite(tokenBudgetRaw) && tokenBudgetRaw > 0
        ? tokenBudgetRaw
        : null;
    const ciRaw = map['ci'];
    const ci = typeof ciRaw === 'string' && ciRaw.trim() !== '' ? ciRaw.trim() : null;
    const auditRaw = map['audit'];
    const audit =
      typeof auditRaw === 'number' && Number.isFinite(auditRaw) && auditRaw > 0 && auditRaw <= 1
        ? auditRaw
        : null;
    const semantic = map['semantic'] === true;
    phases.push({
      id,
      title: typeof map['title'] === 'string' && map['title'].trim() !== '' ? map['title'] : id,
      wip,
      claim: map['claim'] === true,
      handover: typeof map['handover'] === 'string' && map['handover'].trim() !== '' ? map['handover'] : 'manual',
      worker,
      model,
      prompt,
      interactive,
      maxRed,
      tokenBudget,
      ci,
      audit,
      semantic,
    });
  }
  return { phases, pushRemote, error: null, issues };
}

// --- pipeline.md patching (the settings dialog's writer, M85) ----------------

export interface PhasePoolPatch {
  /** `opencode` or `claude-code` sets the worker (and the `agent` handover);
   *  null clears it — the column becomes a manual step and loses its pool. */
  readonly worker?: string | null;
  /** The model pin; an empty string or null clears it. */
  readonly model?: string | null;
  /** The prompt ref override; an empty string or null clears it. */
  readonly prompt?: string | null;
}

/**
 * The one patcher for a phase's pool keys in `_meta/pipeline.md` — the
 * settings dialog writes through here, so a hand-formatted file keeps
 * its layout, comments and unknown keys (the same document-mutation
 * discipline as the ticket patcher). Setting a worker writes the
 * matching `agent <prompt-ref>` handover; clearing it writes `manual`.
 * Throws on an unparseable pipeline or an unknown phase — the caller
 * refuses, it never guesses.
 */
export function patchPipelinePhase(text: string, phaseId: string, patch: PhasePoolPatch): string {
  const { yamlText, body, hadFence } = splitFrontmatter(text);
  if (!hadFence || yamlText === null) {
    throw new Error('pipeline.md has no frontmatter fence');
  }
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    throw new Error('pipeline.md does not parse');
  }
  const phases = doc.get('phases', true);
  if (!isCollection(phases)) {
    throw new Error('pipeline.md needs a phases list');
  }
  let entry: YAMLMap | null = null;
  for (const item of (phases as YAMLSeq).items) {
    const value = isMap(item) ? item : null;
    if (value !== null && value.get('id') === phaseId) {
      entry = value;
      break;
    }
  }
  if (entry === null) {
    throw new Error(`pipeline.md has no phase "${phaseId}"`);
  }

  const removeKey = (key: string): void => {
    if (entry!.has(key)) {
      entry!.delete(key);
    }
  };

  if (patch.worker !== undefined) {
    const worker = patch.worker?.trim() ?? '';
    if (worker === '') {
      // A manual step: the pool and its keys go with the worker.
      removeKey('worker');
      removeKey('model');
      removeKey('workers');
      removeKey('prompt');
      entry.set('handover', 'manual');
    } else {
      entry.set('worker', worker);
      const handover = parseHandover(String(entry.get('handover') ?? ''));
      const promptFromPatch =
        patch.prompt !== undefined && patch.prompt !== null && patch.prompt.trim() !== ''
          ? patch.prompt.trim()
          : null;
      const promptFromKey =
        typeof entry.get('prompt') === 'string' && (entry.get('prompt') as string).trim() !== ''
          ? (entry.get('prompt') as string).trim()
          : null;
      const ref = promptFromPatch ?? promptFromKey ?? handover.promptRef ?? `${phaseId}-default`;
      entry.set('handover', `agent ${ref}`);
    }
  }
  if (patch.model !== undefined) {
    const model = patch.model?.trim() ?? '';
    if (model === '') {
      removeKey('model');
    } else {
      entry.set('model', model);
    }
  }
  if (patch.prompt !== undefined) {
    const prompt = patch.prompt?.trim() ?? '';
    if (prompt === '') {
      removeKey('prompt');
    } else {
      entry.set('prompt', prompt);
    }
  }

  let yaml = doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
  if (!yaml.endsWith('\n')) {
    yaml += '\n';
  }
  return `---\n${yaml}---\n${body}`;
}

/**
 * Rewrites the order of pipeline.md's phases (req-50, the settings page's
 * sortable columns). `order` must name every phase exactly once, and the
 * first (capture target) and last (terminal) phase keep their places.
 * Each entry moves whole — keys, comments and the prose body stay.
 */
export function reorderPipelinePhases(text: string, order: readonly string[]): string {
  const { yamlText, body, hadFence } = splitFrontmatter(text);
  if (!hadFence || yamlText === null) {
    throw new Error('pipeline.md has no frontmatter fence');
  }
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    throw new Error('pipeline.md does not parse');
  }
  const phases = doc.get('phases', true);
  if (!isCollection(phases)) {
    throw new Error('pipeline.md needs a phases list');
  }
  const items = (phases as YAMLSeq).items;
  const idOf = (item: unknown): string | null => {
    const id = isMap(item) ? item.get('id') : null;
    return typeof id === 'string' ? id : null;
  };
  const current = items.map(idOf);
  if (
    order.length !== current.length ||
    new Set(order).size !== order.length ||
    current.some((id) => id === null || !order.includes(id))
  ) {
    throw new Error('the new order must name every pipeline phase exactly once');
  }
  if (order[0] !== current[0] || order[order.length - 1] !== current[current.length - 1]) {
    throw new Error('the first and the last phase keep their places');
  }
  (phases as YAMLSeq).items = order.map((id) => items[current.indexOf(id)]!);
  let yaml = doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
  if (!yaml.endsWith('\n')) {
    yaml += '\n';
  }
  return `---\n${yaml}---\n${body}`;
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

/** Strips one id from every pin section, in text form — a moved or
 *  archived ticket leaves all of them (T-0041 moved this beside its
 *  building blocks so every writer shares it). */
export function removeIdFromPins(orderText: string, id: string): string {
  const { pins } = parseOrderFile(orderText);
  let touched = false;
  const cleaned: Record<string, string[]> = {};
  for (const [section, ids] of Object.entries(pins)) {
    const kept = ids.filter((x) => x !== id);
    if (kept.length !== ids.length) {
      touched = true;
    }
    cleaned[section] = kept;
  }
  if (!touched) {
    return orderText;
  }
  let text = orderText;
  for (const [section, ids] of Object.entries(cleaned)) {
    text = rewriteOrderSection(text, section, ids);
  }
  return text;
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
      worker: typeof map['worker'] === 'string' && map['worker'].trim() !== '' ? map['worker'].trim() : null,
      worktrees: typeof map['worktrees'] === 'string' && map['worktrees'].trim() !== '' ? map['worktrees'].trim() : null,
    });
    const links = parseRepoLinks(map['link']);
    if (typeof links === 'string') {
      return { repos: [], error: `repos.md: repo "${name}" ${links}` };
    }
    if (links.length > 0) {
      repos[repos.length - 1] = { ...repos[repos.length - 1]!, link: links };
    }
  }
  return { repos, error: null };
}

/**
 * `link:` (req-56) — the checkout's git-ignored folders a fleet worktree
 * borrows instead of rebuilding (`.tools`, `node_modules`): one name or a
 * list, each relative to the repo root, never leaving it. A string is
 * the reason it is refused.
 */
function parseRepoLinks(raw: unknown): readonly string[] | string {
  if (raw === undefined || raw === null) {
    return [];
  }
  const items = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : null;
  if (items === null || items.some((item) => typeof item !== 'string')) {
    return 'link: must be a folder name or a list of them';
  }
  const links: string[] = [];
  for (const item of items as string[]) {
    const rel = item.trim().replaceAll('\\', '/').replace(/\/+$/, '');
    if (rel === '') {
      continue;
    }
    if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.split('/').some((part) => part === '..' || part === '.')) {
      return `link: "${item}" must be a path inside the repo (no absolute path, no ..)`;
    }
    links.push(rel);
  }
  return links;
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
  /** The plugin's configured default worker (M84) — what cards show when
   *  nothing above them pins one. */
  readonly defaultWorker: string;
}

/** Files under `tickets/` that are neither `_meta` nor ticket-shaped. */
function strayFileIssue(path: string): TicketIssue {
  return { level: 'noise', message: `unexpected file in the tickets tree: ${path}` };
}

export function assembleBoard(input: AssembleInput): BoardSnapshot {
  const issues: TicketIssue[] = [];

  const pipelineParse = input.pipelineText === null
    ? { phases: [], pushRemote: null, error: 'tickets/_meta/pipeline.md is missing', issues: [] }
    : parsePipeline(input.pipelineText);
  if (pipelineParse.error !== null) {
    issues.push({ level: 'error', message: pipelineParse.error });
  }
  for (const issue of pipelineParse.issues) {
    issues.push({ level: issue.level, message: issue.message });
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
  // the duplicate and dependency passes, then flow into columns as-is
  // (structural match).
  interface AssemblyCard extends TicketCard {
    issues: TicketIssue[];
    blocked: readonly string[];
    blocks: readonly string[];
  }
  const byPhase = new Map<string, AssemblyCard[]>();
  for (const file of input.files) {
    // The reserved archive folder (T-0041): beside `_meta`, never a
    // column, never a counter, never a stray badge — invisible here.
    // (Normalization still treats files moved into it; deletion inside
    // it stays the owner's manual act.)
    if (file.path.startsWith(`${TICKETS_ARCHIVE_DIR}/`)) {
      continue;
    }
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
      worker: resolveCardWorker(
        parsed.meta.worker,
        phases.find((p) => p.id === parts.phase)?.handover ?? null,
        reposParse.repos.find((r) => r.name === parsed.meta.repo)?.worker ?? null,
        input.defaultWorker,
      ),
      issues: [...parsed.issues],
      blocked: [],
      blocks: [],
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

  // The dependency pass (T-0050) runs on the final card list in column
  // order (configured phases first, then unknown directories sorted —
  // a duplicate id resolves to the first occurrence): every card gains
  // its derived blocked/blocks state, and the pass's findings join the
  // per-card issues. Blocked is derived, never stored.
  const knownDirs = new Set([...phaseIds, '_meta']);
  const orderedCards: readonly AssemblyCard[] = [
    ...phases.flatMap((phase) => byPhase.get(phase.id) ?? []),
    ...[...byPhase.keys()]
      .filter((dir) => !knownDirs.has(dir))
      .sort()
      .flatMap((dir) => byPhase.get(dir) ?? []),
  ];
  const terminalPhase = phases.length > 0 ? phases[phases.length - 1]!.id : '';
  const dependencies = runDependencyPass(orderedCards, terminalPhase);
  for (const card of orderedCards) {
    card.blocked = dependencies.blocked.get(card.id) ?? [];
    card.blocks = dependencies.blocks.get(card.id) ?? [];
    card.issues.push(...(dependencies.issuesByCard.get(card.id) ?? []));
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
  for (const dir of [...byPhase.keys()].sort()) {
    if (!knownDirs.has(dir)) {
      issues.push({ level: 'warning', message: `directory "${dir}" is not a phase in pipeline.md` });
      columns.push({
        phase: phaseWithoutPoolKeys({ id: dir, title: dir, wip: null, claim: false, handover: 'manual' }),
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
    defaultWorker: input.defaultWorker,
    pipeline: phases,
    pipelineError: pipelineParse.error,
    pushRemote: pipelineParse.pushRemote,
    repos: reposParse.repos,
    reposError: reposParse.error,
    columns,
    issues,
    checkpoints: [...checkpointPhaseIds(columns)],
  };
}
