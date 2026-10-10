/**
 * The `tasks_list` plugin tool (SDK 1.11): one JSON object per line from
 * the base task-index seam — the model answers task questions from real
 * index rows (never quoted from memory), and the panel renders the
 * persisted result as an interactive task block. The spec rides every
 * non-live ask's tool set (no MCP gate); `null` port = no tool.
 */
import type { ToolSpec } from '../../../shared/llm';
import type { SdkTaskRecord, TaskQueryProvider } from '../../../shared/plugin-api';
import type { ChatToolEntry } from '../shared/chat-note.js';

/** Row cap for one tool result (JSON lines to the model). */
const TASKS_TOOL_MAX_RESULTS = 150;

export const TASKS_LIST_TOOL_NAME = 'tasks_list';

export const TASKS_LIST_SPEC: ToolSpec = {
  name: TASKS_LIST_TOOL_NAME,
  description:
    "List the user's tasks from the app's task index (checkbox and #task lines, with " +
    'due dates and priorities, across all vaults or one vault). One JSON object per ' +
    'line: path, vaultId, line, text, done, kind, heading, tags, due, priority, ' +
    'completed — already sorted by importance (due date first; completed tasks ' +
    'newest first). Returns OPEN tasks unless status says otherwise. Use it ' +
    'for any question about tasks, to-dos or deadlines — always answer from this ' +
    'result instead of quoting task lines you saw in retrieved context. ' +
    'IMPORTANT: when the question names a person, project or topic, you MUST pass it ' +
    'as the text argument (e.g. "tasks of Henrik" → {"text":"Henrik"}); when it names ' +
    'a #tag, pass the tag argument. Call with NO filters only when the question is ' +
    'about the whole task set.',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['open', 'done', 'all'],
        description:
          'Which tasks: "open" (default), "done" = ONLY completed tasks, newest completion first, "all" = both. Set "done" whenever the question asks about completed / finished / done tasks.',
      },
      completedSince: {
        type: 'string',
        description:
          'Only tasks completed on or after this date, YYYY-MM-DD. For "recently completed", pass a date about two weeks before today. Implies status "done".',
      },
      includeDone: {
        type: 'boolean',
        description: 'Legacy form of status "all". Default false.',
      },
      vaultId: {
        type: 'string',
        description: 'Restrict to one vault id. Default: all registered vaults.',
      },
      text: {
        type: 'string',
        description:
          "A word the question restricts to — a person, project or topic (e.g. \"Henrik\"). ALL result tasks contain it in their text or heading. ALWAYS set this when the question names one.",
      },
      tag: {
        type: 'string',
        description:
          'Only tasks whose section carries this tag (subtags included), e.g. "blockuniversum".',
      },
      overdue: {
        type: 'boolean',
        description: 'Only tasks whose due date is before today. Default false.',
      },
      sort: {
        type: 'string',
        enum: ['importance', 'due', 'priority', 'file', 'completed'],
        description:
          'List order. Default "importance": due date ascending (overdue first), then priority, then file order. With status "done" the default is "completed": completion date, newest first.',
      },
    },
  },
};

type TaskToolSort = 'importance' | 'due' | 'priority' | 'file' | 'completed';

/** The sort values the tool accepts, mapped onto the provider's options. */
const SORTS: ReadonlySet<string> = new Set(['importance', 'due', 'priority', 'file', 'completed']);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Runs one `tasks_list` call against the registered provider; text result for the model. */
export async function runTasksListTool(
  provider: TaskQueryProvider,
  argsJson: string,
): Promise<string> {
  let includeDone = false;
  let vaultId: string | undefined;
  let text: string | undefined;
  let tag: string | undefined;
  let overdue = false;
  let status: 'open' | 'done' | 'all' | undefined;
  let completedSince: string | undefined;
  let sort: TaskToolSort | undefined;
  try {
    const parsed: unknown = JSON.parse(argsJson || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const args = parsed as Record<string, unknown>;
      includeDone = args['includeDone'] === true;
      overdue = args['overdue'] === true;
      if (typeof args['vaultId'] === 'string' && args['vaultId'] !== '') {
        vaultId = args['vaultId'];
      }
      if (typeof args['text'] === 'string' && args['text'].trim() !== '') {
        text = args['text'].trim();
      }
      if (typeof args['tag'] === 'string' && args['tag'].trim().replace(/^#/, '') !== '') {
        // The leading `#` is accepted (and stripped) — the MCP tool and
        // the provider's own matcher take the same shape.
        tag = args['tag'].trim().replace(/^#/, '');
      }
      if (typeof args['sort'] === 'string' && SORTS.has(args['sort'])) {
        sort = args['sort'] as TaskToolSort;
      }
      const statusArg = args['status'];
      if (statusArg === 'open' || statusArg === 'done' || statusArg === 'all') {
        status = statusArg;
      }
      if (typeof args['completedSince'] === 'string' && ISO_DATE.test(args['completedSince'])) {
        // A completion-date restriction only makes sense over completed tasks.
        completedSince = args['completedSince'];
        status = 'done';
      }
    }
  } catch {
    return `Could not parse arguments: ${argsJson}`;
  }
  const records = await provider.query({
    includeDone,
    sort: sort ?? (status === 'done' ? 'completed' : 'importance'),
    ...(status !== undefined ? { status } : {}),
    ...(completedSince !== undefined ? { completedSince } : {}),
    ...(vaultId !== undefined ? { vaultId } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(tag !== undefined ? { tag } : {}),
    ...(overdue ? { overdue: true } : {}),
  });
  if (records.length === 0) {
    return 'No tasks found.';
  }
  const shown = records.slice(0, TASKS_TOOL_MAX_RESULTS);
  const lines: string[] = shown.map((task) => JSON.stringify(task));
  if (records.length > shown.length) {
    lines.push(`{"truncated": ${records.length - shown.length}}`);
  }
  return lines.join('\n');
}

/**
 * Answer matching (57b) — the language-independent trigger for the
 * post-hoc task block: an answer "talks about tasks" when enough of a
 * task's significant words appear in it. Normalization keeps only
 * letters/digits/spaces (Unicode aware) and tokens of >= 4 characters, so
 * it works for whatever language the vault is written in — the answer
 * quotes the task text's own words. A task matches at OVERLAP_MIN of its
 * tokens (and at least SHARED_MIN of them); one matched task means the
 * answer is task-shaped. Known limit: a FULLY translated paraphrase of a
 * task (no shared words at all) stays under the threshold — models quote
 * task titles verbatim in practice, which is what this matcher anchors
 * to. One matched task means the answer is task-shaped.
 *
 * Short tasks (57d): a task with fewer than SHARED_MIN significant words
 * could never reach the threshold, so it matches when ALL of its words
 * appear — but only from SHORT_MIN words up; a one-word task would match
 * any answer that happens to use the word.
 */
const TOKEN_MIN = 4;
const OVERLAP_MIN = 0.4;
const SHARED_MIN = 4;
const SHORT_MIN = 2;

function normalizeTokens(text: string): Set<string> {
  const cleaned = text.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ');
  const tokens = new Set<string>();
  for (const token of cleaned.split(/\s+/)) {
    if (token.length >= TOKEN_MIN) {
      tokens.add(token);
    }
  }
  return tokens;
}

export function matchTasksInAnswer(
  answer: string,
  records: readonly SdkTaskRecord[],
): SdkTaskRecord[] {
  const answerTokens = normalizeTokens(answer);
  if (answerTokens.size === 0) {
    return [];
  }
  return records.filter((record) => {
    const tokens = normalizeTokens(record.text);
    if (tokens.size < SHORT_MIN) {
      return false;
    }
    let shared = 0;
    for (const token of tokens) {
      if (answerTokens.has(token)) {
        shared += 1;
      }
    }
    return shared >= Math.min(SHARED_MIN, tokens.size) && shared / tokens.size >= OVERLAP_MIN;
  });
}

/**
 * Matches persisted fence records against the CURRENT index (hydrated at
 * render time — a fence row's done/due can be stale the moment the note
 * changed after the answer). Identity: same vault + path, then the exact
 * line, else the same text+kind (the line may have shifted); ambiguous
 * twins keep the persisted row as-is.
 */
export function hydrateTaskRecords(
  persisted: readonly SdkTaskRecord[],
  current: readonly SdkTaskRecord[],
): SdkTaskRecord[] {
  const byFile = new Map<string, SdkTaskRecord[]>();
  for (const record of current) {
    const key = `${record.vaultId}::${record.path}`;
    byFile.set(key, [...(byFile.get(key) ?? []), record]);
  }
  return persisted.map((record) => {
    const candidates = byFile.get(`${record.vaultId}::${record.path}`) ?? [];
    const exact = candidates.find((c) => c.line === record.line);
    if (exact !== undefined) {
      return exact;
    }
    const sameText = candidates.filter((c) => c.text === record.text && c.kind === record.kind);
    return sameText.length === 1 ? sameText[0] : record;
  });
}

/** Parses the tool's JSON-lines result format back into records (the panel keeps its own twin). */
export function parseTaskRecords(content: string): SdkTaskRecord[] {
  const records: SdkTaskRecord[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        typeof (parsed as Record<string, unknown>)['text'] === 'string' &&
        typeof (parsed as Record<string, unknown>)['path'] === 'string' &&
        (parsed as Record<string, unknown>)['truncated'] === undefined
      ) {
        records.push(parsed as SdkTaskRecord);
      }
    } catch {
      // A stray line stays unparsed.
    }
  }
  return records;
}

/**
 * Whether one `tasks_list` call's arguments carry a scope restriction
 * (text/tag/overdue — the fields that NARROW the set). `sort` and
 * `includeDone` only reorder or widen, so an unfiltered-by-scope call is
 * one the refine step may trim (57c).
 */
export function taskArgsCarryScopeRestriction(args: unknown): boolean {
  let parsed: unknown = args;
  if (typeof args === 'string') {
    try {
      parsed = JSON.parse(args || '{}');
    } catch {
      return false;
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false;
  }
  const record = parsed as Record<string, unknown>;
  const text = record['text'];
  const tag = record['tag'];
  const since = record['completedSince'];
  return (
    (typeof text === 'string' && text.trim() !== '') ||
    (typeof tag === 'string' && tag.trim().replace(/^#/, '') !== '') ||
    record['overdue'] === true ||
    // A done-only view is the scope the question asked for (57d): the
    // refine must not trim it to the few tasks the prose happens to quote.
    record['status'] === 'done' ||
    (typeof since === 'string' && ISO_DATE.test(since))
  );
}

/**
 * The answer-scoped refine (57c): when the model called `tasks_list`
 * WITHOUT a scope restriction but its answer only talks about a strict
 * subset of the returned tasks, the persisted result is trimmed to that
 * subset (same order). This is the deterministic guarantee behind the
 * intent prompt: a 9B model that calls `{"text":"Henrik"}` gets exactly
 * Henrik's tasks from the provider; one that calls `{}` still gets a
 * block scoped to what its answer actually discussed. Entries without an
 * unfiltered `tasks_list` result pass through unchanged.
 */
export function refineTasksEntries(
  entries: readonly ChatToolEntry[],
  answer: string,
): ChatToolEntry[] {
  const out = [...entries];
  for (let i = 0; i < out.length; i++) {
    const entry = out[i];
    if (entry.kind !== 'call' || entry.name !== TASKS_LIST_TOOL_NAME) {
      continue;
    }
    if (taskArgsCarryScopeRestriction(entry.arguments)) {
      continue;
    }
    const resultIndex = out.findIndex((e) => e.kind === 'result' && e.id === entry.id);
    const result = resultIndex >= 0 ? out[resultIndex] : undefined;
    if (result === undefined || result.kind !== 'result') {
      continue;
    }
    const records = parseTaskRecords(result.content);
    if (records.length === 0) {
      continue;
    }
    const matched = matchTasksInAnswer(answer, records);
    if (matched.length === 0 || matched.length >= records.length) {
      continue; // nothing matched (the answer stands) or the full set is the scope
    }
    out[resultIndex] = {
      kind: 'result',
      id: result.id,
      content: matched.map((task) => JSON.stringify(task)).join('\n'),
    };
  }
  return out;
}
