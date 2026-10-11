/**
 * How the assistant panel words what a turn carries: tool calls and
 * results, a `tasks_list` result's rows and filters, the Vault chip's
 * tooltip. Text in, text out -- no DOM, so it is tested directly.
 */
import type { SdkTaskRecord } from '../../../shared/plugin-api/renderer';
import type { AssistantState } from './state.js';

/** The `tasks_list` tool whose persisted result renders as a task block. */
export const TASKS_LIST_TOOL = 'tasks_list';

/** Parses one `tasks_list` tool result: JSON lines of records (+ a truncation note). */
export function parseTasksResult(content: string): {
  records: SdkTaskRecord[];
  truncated: number;
} {
  const records: SdkTaskRecord[] = [];
  let truncated = 0;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (typeof record['text'] === 'string' && typeof record['path'] === 'string') {
          records.push(parsed as SdkTaskRecord);
        } else if (typeof record['truncated'] === 'number') {
          truncated = record['truncated'];
        }
      }
    } catch {
      // A stray line stays unparsed — the rows carry real data only.
    }
  }
  return { records, truncated };
}

/**
 * The filter chips one `tasks_list` call's arguments describe (57c):
 * `#tag`, quoted text terms, overdue, completed / done-included — rendered in the
 * block head so a filtered view explains itself. Unparseable args
 * (the `{"posthoc":true}` sentinel among them) yield no chips.
 */
export function taskFilterLabelParts(argsJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(argsJson || '{}');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return [];
    }
    const args = parsed as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof args['tag'] === 'string' && args['tag'].trim() !== '') {
      parts.push(`#${args['tag'].trim().replace(/^#/, '')}`);
    }
    if (typeof args['text'] === 'string' && args['text'].trim() !== '') {
      parts.push(`"${args['text'].trim()}"`);
    }
    if (args['overdue'] === true) {
      parts.push('overdue');
    }
    const since = args['completedSince'];
    const hasSince = typeof since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(since);
    if (args['status'] === 'done' || hasSince) {
      parts.push(hasSince ? `completed since ${since as string}` : 'completed');
    } else if (args['includeDone'] === true || args['status'] === 'all') {
      parts.push('done included');
    }
    return parts;
  } catch {
    return [];
  }
}

/** First line of a tool result, for the chip's summary line. */
export function firstLine(text: string): string {
  const line = text.split('\n').find((entry) => entry.trim() !== '') ?? '';
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

/** The Vault chip's tooltip: what the next ask searches (names when known). */
export function vaultScopeTitle(
  state: Pick<AssistantState, 'vaultScope' | 'vaults' | 'customVaultIds'>,
): string {
  const scope = state.vaultScope();
  if (scope === 'vault') {
    return 'Vault context: the most similar sections of the active vault. Click to change.';
  }
  if (scope === 'all') {
    return 'Vault context: the most similar sections across every vault. Click to change.';
  }
  if (scope === 'custom') {
    const byId = new Map(state.vaults().map((vault) => [vault.id, vault.name]));
    const ids = state.customVaultIds();
    const names = ids.map((id) => byId.get(id));
    const listed = names.every((name) => name !== undefined)
      ? (names as string[]).join(', ')
      : `${ids.length} vault${ids.length === 1 ? '' : 's'}`;
    return `Vault context: the most similar sections of ${listed}. Click to change.`;
  }
  return 'Vault context: pick which vaults the assistant searches — the active one, all of them, or a selection.';
}

/** `mcp__<server>__<tool>` reads as "server · tool"; any other name as it is. */
export function toolDisplayName(name: string): string {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match !== null ? `${match[1]} · ${match[2]}` : name;
}

/** Compact argument summary for a call chip. */
export function summarizeArguments(args: unknown): string {
  if (typeof args === 'string') {
    const cleaned = args.replace(/^\{|\}$/g, '').trim();
    return cleaned === '' ? '' : cleaned;
  }
  if (args !== null && typeof args === 'object') {
    const parts = Object.entries(args as Record<string, unknown>).map(
      ([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
    );
    const joined = parts.join(', ');
    return joined.length > 48 ? `${joined.slice(0, 48)}…` : joined;
  }
  return '';
}

/** The full arguments of a call, pretty-printed for the expanded chip. */
export function formatArguments(args: unknown): string {
  if (typeof args === 'string') {
    try {
      return JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      return args;
    }
  }
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}
