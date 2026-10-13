/**
 * The `tasks_list` tool — its description and its runner, once (ADR-0071).
 * The vault MCP server offers it to connected programs and the assistant
 * attaches it to its own asks; both read the task index through the
 * `TaskQueryProvider` seam (SDK 1.11). Pure: the caller supplies the
 * provider.
 *
 * One JSON object per line, so every consumer parses one format — the
 * assistant panel renders the persisted result as its task block.
 */
import type { ToolSpec } from './llm';
import type { TaskQueryProvider } from './plugin-api';

export const TASKS_LIST_TOOL_NAME = 'tasks_list';

/** Row cap of one result. */
export const TASKS_LIST_MAX_RESULTS = 150;

export const TASKS_LIST_SPEC: ToolSpec = {
  name: TASKS_LIST_TOOL_NAME,
  description:
    "List the user's tasks from the app's task index (checkbox and #task lines, with " +
    'due dates and priorities, across all vaults or one vault). One JSON object per ' +
    'line: path, vaultId, line, text, done, kind, heading, tags, due, priority, ' +
    'completed — already sorted by importance (due date first; completed tasks ' +
    'newest first). Returns OPEN tasks unless status says otherwise. Use it ' +
    'for any question about tasks, to-dos or deadlines — always answer from this ' +
    'result instead of quoting task lines you saw elsewhere. ' +
    'IMPORTANT: when the question names a person, project or topic, you MUST pass it ' +
    'as the text argument (e.g. "tasks of Henrik" → {"text":"Henrik"}); when it names ' +
    'a #tag, pass the tag argument. Call with NO filters only when the question is ' +
    'about the whole task set. If a result does not cover the question, call again ' +
    'with other arguments.',
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
      vault: {
        type: 'string',
        description: 'Restrict to one vault id. Default: all registered vaults.',
      },
      text: {
        type: 'string',
        description:
          'A word the question restricts to — a person, project or topic (e.g. "Henrik"). ALL result tasks contain it in their text or heading. ALWAYS set this when the question names one.',
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

type TaskSort = 'importance' | 'due' | 'priority' | 'file' | 'completed';

const SORTS: ReadonlySet<string> = new Set(['importance', 'due', 'priority', 'file', 'completed']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Runs one `tasks_list` call; the text the model gets back. */
export async function runTasksList(
  provider: TaskQueryProvider,
  args: Record<string, unknown>,
): Promise<string> {
  // `vaultId` is what the assistant's own tool called it before the two
  // definitions became one; chat notes written then still replay it.
  const vaultArg = args['vault'] ?? args['vaultId'];
  const vaultId =
    typeof vaultArg === 'string' && vaultArg !== '' && vaultArg !== 'all' ? vaultArg : undefined;
  const text =
    typeof args['text'] === 'string' && args['text'].trim() !== '' ? args['text'].trim() : undefined;
  // The leading `#` is accepted (and stripped): the provider's matcher
  // takes the bare tag.
  const tag =
    typeof args['tag'] === 'string' && args['tag'].trim().replace(/^#/, '') !== ''
      ? args['tag'].trim().replace(/^#/, '')
      : undefined;
  const sort =
    typeof args['sort'] === 'string' && SORTS.has(args['sort'])
      ? (args['sort'] as TaskSort)
      : undefined;
  const completedSince =
    typeof args['completedSince'] === 'string' && ISO_DATE.test(args['completedSince'])
      ? args['completedSince']
      : undefined;
  const statusArg = args['status'];
  // A completion-date restriction only makes sense over completed tasks.
  const status =
    completedSince !== undefined
      ? 'done'
      : statusArg === 'open' || statusArg === 'done' || statusArg === 'all'
        ? statusArg
        : undefined;

  const records = await provider.query({
    includeDone: args['includeDone'] === true,
    sort: sort ?? (status === 'done' ? 'completed' : 'importance'),
    ...(status !== undefined ? { status } : {}),
    ...(completedSince !== undefined ? { completedSince } : {}),
    ...(vaultId !== undefined ? { vaultId } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(tag !== undefined ? { tag } : {}),
    ...(args['overdue'] === true ? { overdue: true } : {}),
  });
  if (records.length === 0) {
    return 'No tasks found.';
  }
  const shown = records.slice(0, TASKS_LIST_MAX_RESULTS);
  const lines: string[] = shown.map((task) => JSON.stringify(task));
  if (records.length > shown.length) {
    lines.push(`{"truncated": ${records.length - shown.length}}`);
  }
  return lines.join('\n');
}
