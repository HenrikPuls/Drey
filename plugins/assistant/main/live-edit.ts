/**
 * Live edit (ADR-0049): the document tools behind the assistant's
 * immediate-apply editing mode. A `LiveEditSession` owns a working copy of
 * the note (seeded from the live buffer at send time) and serves the three
 * `doc_*` tools the model calls through the provider tool loop — every
 * mutation bumps `work` and is pushed to the editor by the engine
 * (`ports.onLiveEdit`), so changes appear while the model still works.
 *
 * Pure module — no Node imports, so the Angular-runner spec can import it
 * (the runner ignores `plugins/**` for specs, not for imports).
 *
 * Tool handlers NEVER throw: a thrown error would fail the whole chat call
 * (the providers don't catch around `onToolCall`); problems are returned
 * as error text so the model can self-correct.
 */
import type { ToolSpec } from '../../../shared/llm';
import { normalizeDoc } from './action-engine';

/** One search/replace hunk; `find` must match the working copy exactly once. */
export interface LiveEditHunk {
  find: string;
  replace: string;
}

/** A finished tool run: the text for the model, and whether `work` changed. */
export interface LiveEditToolResult {
  text: string;
  mutated: boolean;
}

export interface LiveEditSession {
  readonly path: string;
  /** The working copy (LF, trailing newline after any mutation). */
  work: string;
  /** Applied hunks / whole-document replacements so far. */
  editCount: number;
  runTool(name: string, argsJson: string): Promise<LiveEditToolResult>;
}

/** Cap on the lines `doc_read` dumps without a `from`/`to` range. */
const READ_CAP_LINES = 400;

function firstLineOf(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

function lineOfIndex(doc: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < doc.length; i++) {
    if (doc.charCodeAt(i) === 10) {
      line++;
    }
  }
  return line;
}

/** Counts non-overlapping occurrences of `find` in `doc`; empty `find` counts as 0. */
function countOccurrences(doc: string, find: string): number {
  if (find === '') {
    return 0;
  }
  let count = 0;
  let at = doc.indexOf(find);
  while (at !== -1) {
    count++;
    at = doc.indexOf(find, at + find.length);
  }
  return count;
}

/** Creates a session over the note's current buffer text. */
export function createLiveEditSession(path: string, body: string): LiveEditSession {
  const session: LiveEditSession = {
    path,
    work: body,
    editCount: 0,
    async runTool(name, argsJson) {
      let args: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(argsJson || '{}');
        if (parsed !== null && typeof parsed === 'object') {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        return { text: `Could not parse arguments for ${name}: ${argsJson}`, mutated: false };
      }
      switch (name) {
        case 'doc_apply_diff':
          return applyDiff(session, args);
        case 'doc_write':
          return writeDoc(session, args);
        case 'doc_read':
          return readDoc(session, args);
        default:
          return { text: `Unknown tool ${name}.`, mutated: false };
      }
    },
  };
  return session;
}

/** `doc_apply_diff`: apply ALL hunks atomically, or none. */
function applyDiff(session: LiveEditSession, args: Record<string, unknown>): LiveEditToolResult {
  const raw = args['hunks'];
  if (!Array.isArray(raw) || raw.length === 0) {
    return { text: 'doc_apply_diff needs a non-empty "hunks" array.', mutated: false };
  }
  const hunks: LiveEditHunk[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i] as Record<string, unknown> | null;
    const find = entry !== null && typeof entry === 'object' ? entry['find'] : undefined;
    const replace = entry !== null && typeof entry === 'object' ? entry['replace'] : undefined;
    if (typeof find !== 'string' || typeof replace !== 'string') {
      return {
        text: `Hunk ${i + 1}: each hunk needs string "find" and string "replace".`,
        mutated: false,
      };
    }
    if (find === '') {
      return { text: `Hunk ${i + 1}: "find" must not be empty.`, mutated: false };
    }
    hunks.push({ find, replace });
  }

  // Validate every hunk against the evolving copy BEFORE applying anything —
  // a later hunk may rely on an earlier one's replacement, but a hunk that
  // matches zero or several times aborts the whole call.
  let simulated = session.work;
  const touched: number[] = [];
  for (let i = 0; i < hunks.length; i++) {
    const { find } = hunks[i];
    const at = simulated.indexOf(find);
    const count = countOccurrences(simulated, find);
    if (count !== 1) {
      const where =
        count === 0
          ? `not found — include enough surrounding lines to make it unique`
          : `found ${count} times — add surrounding lines to make it unique`;
      return {
        text: `Hunk ${i + 1} ${where}: ${firstLineOf(find)}`,
        mutated: false,
      };
    }
    touched.push(lineOfIndex(simulated, at));
    simulated = simulated.replace(find, hunks[i].replace);
  }

  session.work = simulated;
  session.editCount += hunks.length;
  const at = [...touched].sort((a, b) => a - b).join(', ');
  return {
    text: `Applied ${hunks.length} hunk(s) at line(s) ${at}.`,
    mutated: true,
  };
}

/** `doc_write`: whole-document replacement (full restructures only). */
function writeDoc(session: LiveEditSession, args: Record<string, unknown>): LiveEditToolResult {
  const content = args['content'];
  if (typeof content !== 'string') {
    return { text: 'doc_write needs a string "content".', mutated: false };
  }
  const next = normalizeDoc(content);
  const lines = next.split('\n').length - 1;
  const replaced = session.work !== next;
  session.work = next;
  if (replaced) {
    session.editCount++;
  }
  return {
    text: `Document replaced (${lines} lines).`,
    mutated: replaced,
  };
}

/** `doc_read`: a 1-based line-numbered window of the working copy. */
function readDoc(session: LiveEditSession, args: Record<string, unknown>): LiveEditToolResult {
  const lines = session.work.split('\n');
  const total = lines.length;
  const fromRaw = typeof args['from'] === 'number' ? Math.round(args['from']) : 1;
  const toRaw =
    typeof args['to'] === 'number' ? Math.round(args['to']) : Math.min(total, READ_CAP_LINES);
  const from = Math.min(Math.max(1, fromRaw), Math.max(1, total));
  const to = Math.min(Math.max(from, toRaw), total);
  const window = lines.slice(from - 1, to);
  const dump = window.map((line, i) => `${String(from + i).padStart(4, ' ')}|${line}`).join('\n');
  const footer = to < total ? `\n[… ${total - to} more lines — request a range with from/to]` : '';
  return { text: dump + footer, mutated: false };
}

/** The tool descriptions handed to the provider alongside the vault set. */
export const LIVE_EDIT_TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'doc_apply_diff',
    description:
      'Apply one or more search/replace hunks to the document. Every "find" must match the ' +
      'document EXACTLY ONCE (include surrounding lines for uniqueness); hunks apply in order, ' +
      'so a later hunk may build on an earlier hunk\'s replacement. The call is atomic: if any ' +
      'hunk does not match, NOTHING is applied and the error names the failing hunk.',
    parameters: {
      type: 'object',
      properties: {
        hunks: {
          type: 'array',
          description: 'The replacements to apply, in order.',
          items: {
            type: 'object',
            properties: {
              find: { type: 'string', description: 'Exact text to replace (unique in the document).' },
              replace: { type: 'string', description: 'The replacement text ("" deletes).' },
            },
            required: ['find', 'replace'],
          },
        },
      },
      required: ['hunks'],
    },
  },
  {
    name: 'doc_write',
    description:
      'Replace the whole document. Only for full restructures — prefer doc_apply_diff for ' +
      'everything else.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The complete new document.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'doc_read',
    description:
      'Read the current document (including your applied changes) with 1-based line numbers. ' +
      'Optional from/to restrict the window (1-based, inclusive); the whole document is capped ' +
      'at 400 lines.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'number', description: 'First line (1-based).' },
        to: { type: 'number', description: 'Last line (1-based, inclusive).' },
      },
    },
  },
];

/** System prompt for a live-edit turn: tools, not the JSON protocol. */
export const LIVE_EDIT_SYSTEM = `You are editing the user's Markdown document. The document's current text is in the user message.

You make changes by calling the doc tools — doc_apply_diff is the default (batch several hunks into one call when they are independent), doc_write only for full restructures. Use doc_read to check the document before or after editing; your changes apply immediately as you make them, and you see their effect on subsequent doc_read calls.

When the requested changes are done, reply with a SHORT plain-text summary of what you changed. Do NOT use any JSON protocol, do NOT repeat the document.`;

/**
 * Appended to `LIVE_EDIT_SYSTEM` when the vault tool set is also available
 * (ADR-0021). Unlike `ASK_TOOLS_NOTE` this makes no mention of a JSON
 * answer — the live protocol is plain text.
 */
export const LIVE_EDIT_TOOLS_NOTE = `You may also call the vault tools (vault_search, vault_read, vault_write) to look things up in the wider vault or to make changes elsewhere. A vault_write is confirmed by the user unless the app is in YOLO mode.`;
