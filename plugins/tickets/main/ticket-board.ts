/**
 * Pure board assembly (ADR-0076): parses the `_meta` configuration,
 * orders columns (derived order — the order.md pins went with the kanban
 * board, req-75), and folds parsed
 * tickets into a snapshot shape. No IO — `index.ts` feeds it files and
 * paths, the specs feed it fixtures. Everything here is deterministic:
 * the same files always produce the same board (no stored state).
 */
import { isCollection, isMap, parseDocument, stringify, type YAMLMap, type YAMLSeq } from 'yaml';
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
  type RecentDone,
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

// --- repos.md --------------------------------------------------------------

export interface ReposParse {
  readonly repos: readonly RepoRef[];
  readonly error: string | null;
  /** Tolerated entries (a non-string `launch:`), one message each. */
  readonly warnings: readonly string[];
}

export function parseRepos(text: string | null): ReposParse {
  if (text === null) {
    return { repos: [], error: null, warnings: [] };
  }
  const { yamlText, hadFence } = splitFrontmatter(text);
  if (!hadFence || yamlText === null) {
    return { repos: [], error: 'repos.md has no frontmatter fence', warnings: [] };
  }
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    return { repos: [], error: `repos.md does not parse: ${doc.errors[0]!.message}`, warnings: [] };
  }
  const parsed = doc.toJS() as unknown;
  const root = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
  const rawRepos = root['repos'];
  if (rawRepos === undefined || rawRepos === null) {
    return { repos: [], error: 'repos.md needs a repos mapping', warnings: [] };
  }
  if (typeof rawRepos !== 'object' || Array.isArray(rawRepos)) {
    return { repos: [], error: 'repos.md: repos must be a mapping of name -> {url, branch, policy}', warnings: [] };
  }
  const repos: RepoRef[] = [];
  const warnings: string[] = [];
  for (const [name, entry] of Object.entries(rawRepos as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { repos: [], error: `repos.md: repo "${name}" must be a mapping`, warnings };
    }
    const map = entry as Record<string, unknown>;
    const url = typeof map['url'] === 'string' ? map['url'].trim() : '';
    if (url === '') {
      return { repos: [], error: `repos.md: repo "${name}" needs a url`, warnings };
    }
    let launch: string | null = null;
    if (map['launch'] !== undefined && map['launch'] !== null) {
      if (typeof map['launch'] === 'string' && map['launch'].trim() !== '') {
        launch = map['launch'].trim();
      } else {
        warnings.push(`repos.md: repo "${name}" launch must be a command string`);
      }
    }
    repos.push({
      name,
      url,
      branch: typeof map['branch'] === 'string' && map['branch'].trim() !== '' ? map['branch'] : null,
      policy: typeof map['policy'] === 'string' && map['policy'].trim() !== '' ? map['policy'] : null,
      path: typeof map['path'] === 'string' && map['path'].trim() !== '' ? map['path'].trim() : null,
      worker: typeof map['worker'] === 'string' && map['worker'].trim() !== '' ? map['worker'].trim() : null,
      worktrees: typeof map['worktrees'] === 'string' && map['worktrees'].trim() !== '' ? map['worktrees'].trim() : null,
      launch,
    });
    const links = parseRepoLinks(map['link']);
    if (typeof links === 'string') {
      return { repos: [], error: `repos.md: repo "${name}" ${links}`, warnings };
    }
    if (links.length > 0) {
      repos[repos.length - 1] = { ...repos[repos.length - 1]!, link: links };
    }
  }
  return { repos, error: null, warnings };
}

/**
 * The prose under `repos.md`'s frontmatter — the notes the owner keeps
 * there. A file without a fence reads as the shipped default prose.
 */
export function reposProse(text: string | null): string {
  if (text === null) {
    return DEFAULT_REPOS_PROSE;
  }
  const { body, hadFence } = splitFrontmatter(text);
  return hadFence && body.trim() !== '' ? body : DEFAULT_REPOS_PROSE;
}

const DEFAULT_REPOS_PROSE = `Work repositories a ticket's \`repos:\` field may name. The fleet never
calls a host API — only plain git (ADR-0075); protection on \`main\` is
the host's branch-policy feature, recorded here when configured.
\`path\` is the local checkout the board's "Open work folder in
terminal" opens.`;

/**
 * Writes `repos.md` from its entries (req-72, the settings page's save):
 * the frontmatter regenerated from the list, the owner's prose kept.
 * Optional keys are omitted when unset, so the file stays hand-readable.
 */
export function reposFileText(repos: readonly RepoRef[], prose: string): string {
  const mapping: Record<string, Record<string, unknown>> = {};
  for (const repo of repos) {
    const entry: Record<string, unknown> = { url: repo.url };
    if (repo.branch !== null) {
      entry['branch'] = repo.branch;
    }
    if (repo.policy !== null) {
      entry['policy'] = repo.policy;
    }
    if (repo.path !== null) {
      entry['path'] = repo.path.replaceAll('\\', '/');
    }
    if (repo.worker !== null) {
      entry['worker'] = repo.worker;
    }
    if (repo.worktrees !== null) {
      entry['worktrees'] = repo.worktrees;
    }
    if (repo.launch !== null) {
      entry['launch'] = repo.launch;
    }
    if (repo.link !== undefined && repo.link.length > 0) {
      entry['link'] = [...repo.link];
    }
    mapping[repo.name] = entry;
  }
  const front = stringify({ repos: mapping }, { lineWidth: 0 }).trimEnd();
  return `---\n${front}\n---\n${prose.trimEnd()}\n`;
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

/** Final column order: the derived order (the order.md pins went with req-75). */
export function orderColumn<T extends { readonly id: string }>(
  tickets: readonly T[],
  keyOf: (ticket: T) => OrderKey,
): T[] {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  // Keys were built from byId itself, so every lookup lands.
  return derivedOrder([...byId.values()].map(keyOf)).map((k) => byId.get(k.id) as T);
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
  readonly reposText: string | null;
  readonly files: readonly BoardFile[];
  /** The plugin's configured default worker (M84) — what cards show when
   *  nothing above them pins one. */
  readonly defaultWorker: string;
  /**
   * The archived tickets of the last 7 days (req-75 W1b), already
   * computed by the caller from the same file list — the pure assembly
   * stays time-free. Default: none.
   */
  readonly recentDone?: readonly RecentDone[];
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

  const reposParse = parseRepos(input.reposText);
  if (reposParse.error !== null) {
    issues.push({ level: 'error', message: reposParse.error });
  }
  for (const warning of reposParse.warnings) {
    issues.push({ level: 'warning', message: warning });
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
    // req-72: every named repo must be known — the primary and the extra
    // ones alike (a typo in the second entry would silently lose a repo).
    for (const name of parsed.meta.repos) {
      if (!repoNames.has(name)) {
        parsed.issues.push({ level: 'warning', message: `repo "${name}" is not in _meta/repos.md` });
      }
    }
    if (parsed.meta.parkedReason !== null && parts.phase !== 'inbox') {
      parsed.issues.push({ level: 'noise', message: 'parked ticket outside inbox — the fields are ignored here' });
    }
    // The card's display worker: the first named repo that pins one (the
    // primary usually decides; an extra repo's pin counts when the
    // primary leaves it open).
    const repoWorker =
      parsed.meta.repos
        .map((name) => reposParse.repos.find((r) => r.name === name)?.worker ?? null)
        .find((worker) => worker !== null) ?? null;
    const card: AssemblyCard = {
      id: parts.stem,
      path: file.path,
      phase: parts.phase,
      meta: parsed.meta,
      worker: resolveCardWorker(
        parsed.meta.worker,
        phases.find((p) => p.id === parts.phase)?.handover ?? null,
        repoWorker,
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
      tickets: orderColumn(tickets, columnKey(phase.id)),
    };
  });
  for (const dir of [...byPhase.keys()].sort()) {
    if (!knownDirs.has(dir)) {
      issues.push({ level: 'warning', message: `directory "${dir}" is not a phase in pipeline.md` });
      columns.push({
        phase: phaseWithoutPoolKeys({ id: dir, title: dir, wip: null, claim: false, handover: 'manual' }),
        unknown: true,
        tickets: orderColumn(byPhase.get(dir)!, columnKey(dir)),
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
    recentDone: [...(input.recentDone ?? [])],
  };
}
