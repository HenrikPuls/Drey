/**
 * The chat-note grammar (ADR-0048): a conversation note under `chats/` is
 * plain Markdown with `kind: chat` frontmatter and one `## User` /
 * `## Assistant` heading per turn — the note IS the source of truth, and a
 * follow-up replays the full persisted history from it (bug-10(b): tool
 * calls/results and applied-edit content survive in `drey-tool` fences).
 *
 * Pure string in, pure string out — the
 * vault IO lives main-side (`main/chat-store.ts`). Parse is defensive in
 * the `parseChatThread` style: malformed pieces degrade (dropped lines,
 * empty turns), `parseChatNote` never throws. Plugin renderers may only
 * *type*-import app `shared/`, so this module is self-contained on
 * purpose (its own frontmatter reader, its own slug) — the algorithmic
 * siblings are `shared/daily.ts` (path nesting), the `yaml`-free reader
 * mirrors `shared/frontmatter.ts` semantics for the handful of fields a
 * chat note carries, and `plugins/meeting/main/slug.ts` (copied, not
 * imported — cross-plugin imports are banned).
 */
import type { ChatMessage } from '../../../shared/llm';

/** Where conversations live, nested per year/month like `daily/`. */
export const CHATS_DIR = 'chats';

/**
 * Whether a vault-relative path is a chat note (the `chats/` auto-save
 * area). The renderer-safe twin of the app's `isAutoSavePath` chats half —
 * plugin modules cannot runtime-import app `shared/`.
 */
export function isChatNotePath(path: string): boolean {
  return path === CHATS_DIR || path.startsWith(`${CHATS_DIR}/`);
}

/** The default daily root, matching `AppConfig.daily.dir`'s fallback. */
export const DEFAULT_DAILY_DIR = 'daily';

/**
 * Whether a vault-relative path sits in the configured daily-notes root
 * (57c decoupling): daily notes never bind a chat and never pull one on
 * focus — a day switch keeps the panel's current conversation. The dir
 * comes from the live app config; it is normalised here so a hand-edited
 * value with a trailing slash or backslashes still matches.
 */
export function isDailyNotePath(path: string, dailyDir: string): boolean {
  const dir = dailyDir.replaceAll('\\', '/').replace(/\/+$/, '');
  if (dir === '' || dir === '.') {
    return false;
  }
  return path === dir || path.startsWith(`${dir}/`);
}

/** The fence tag around persisted tool calls/results/edit outcomes. */
export const TOOL_FENCE_TAG = 'drey-tool';

/** The fence tag around one ask turn's retrieved-vault citations (ADR-0055). */
export const CONTEXT_FENCE_TAG = 'drey-context';

/** Frontmatter `kind:` marking an assistant conversation note (ADR-0048). */
export const CHAT_KIND = 'chat';

/** Turn text standing in for "this turn proposed an edit" (the outcome line carries the result). */
export const EDIT_PROPOSAL_MARKER = '[Proposed a change to';

/** The `<!-- drey: … -->` payload under an Assistant heading. */
export interface ChatTurnMeta {
  durationMs?: number;
  model?: string;
}

/** One attachment link in the link-only block at the end of a User turn. */
export type ChatNoteAttachment =
  | { kind: 'note'; path: string }
  | { kind: 'image'; path: string; alt: string };

/**
 * One persisted tool line inside a ```drey-tool fence — exactly one of
 * `call` / `result` / `edit` per line. `arguments` keeps whatever the
 * line parsed to (object when it was written readable, raw string
 * otherwise); replay stringifies it back for `ChatToolCall.function`.
 */
export type ChatToolEntry =
  | { kind: 'call'; id: string; name: string; arguments: unknown }
  | { kind: 'result'; id: string; content: string }
  | { kind: 'edit'; path: string; applied: boolean; after?: string };

/** One `## User` / `## Assistant` turn. Identity is the turn INDEX in the note. */
export interface ChatNoteTurn {
  role: 'user' | 'assistant';
  /** Local ISO timestamp from the heading (`2026-09-13T14:32:00`), or null. */
  at: string | null;
  meta: ChatTurnMeta;
  /** Body text without the attachment block, tool fences, or the meta comment. */
  text: string;
  /** User turns only: the trailing link-only block. */
  attachments: ChatNoteAttachment[];
  /** ```drey-tool lines in persisted order. */
  tool: ChatToolEntry[];
  /** ```drey-context citations (ADR-0055): what this turn retrieved; assistant turns only. */
  context: ChatContextEntry[];
  /** Why a chip-on turn retrieved nothing (`null` when off or hits came back). */
  contextStatus: ChatContextStatus | null;
  /** Char offset of this turn's heading — `truncateFrom` slices here. */
  start: number;
}

/**
 * One persisted citation line inside a ```drey-context fence.
 */
export interface ChatContextEntry {
  /** The vault's display name; absent on notes written before it existed. */
  vault?: string;
  path: string;
  heading: string;
  line: number;
}

/**
 * What happened when this turn asked the vault (ADR-0055): persisted as a
 * `{"status":…}` line inside the ```drey-context fence whenever the Vault
 * chip was on but produced NO hits — so the panel can say WHY nothing
 * came back (floor too high / retrieval disabled / retrieval failed /
 * the custom selection references no registered vault) instead of
 * staying silent. Plain hits carry no status, just cites.
 */
export type ChatContextStatus =
  | { kind: 'empty'; floor: number }
  | { kind: 'disabled' }
  | { kind: 'unregistered' }
  | { kind: 'error'; message: string };

/** The frontmatter fields a chat note reads. Everything else is the user's. */
export interface ChatNoteFrontmatter {
  kind: string | null;
  provider: string | null;
  model: string | null;
  session: string | null;
  title: string | null;
  created: string | null;
  updated: string | null;
  /**
   * The document the chat is bound to, as the app's doc key
   * (`vaultId::relativePath`); null/absent = an unbound chat (req: the
   * panel follows the active document — switching to a note opens the
   * newest chat bound to it).
   */
  note: string | null;
}

export interface ChatNoteView {
  frontmatter: ChatNoteFrontmatter;
  turns: ChatNoteTurn[];
}

/** One chat in the picker: path + display title + last-activity stamp. */
export interface ChatSummary {
  path: string;
  title: string;
  updated: string | null;
  /** The bound document's doc key, or null for an unbound chat. */
  note: string | null;
}

const EMPTY_FRONTMATTER: ChatNoteFrontmatter = {
  kind: null,
  provider: null,
  model: null,
  session: null,
  title: null,
  created: null,
  updated: null,
  note: null,
};

/**
 * `## User — 2026-09-13T14:32:00`. The en dash is what we write; a plain
 * dash or `--` is tolerated on read (a hand-edited note must not lose its
 * turns).
 */
const HEADING = /^## (User|Assistant)(?:[ ]+(?:[—–]|--|-)[ ]*(\S+))?[ \t]*$/;

/** `<!-- drey: {"durationMs":8123,"model":"glm-4.7"} -->` directly under a heading. */
const META = /^<!--\s*drey:\s*({.*})\s*-->$/;

/** A whole line that is exactly one attachment link and nothing else. */
const WIKILINK_LINE = /^\[\[([^\]]+)\]\]$/;
const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;

/*
 * Chat notes are WRITTEN with LF (chat-store serialises before writing)
 * but a hand-edited file may carry CRLF — parsing normalises first, so
 * offsets stay consistent within the normalised text.
 */
function normalizeEol(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n/g, '\n') : text;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Line-based frontmatter reader for exactly the fields a chat note
 * carries. No `yaml` import — this module must stay loadable from a
 * plugin renderer (type-only app-shared imports only). A hand-edited or
 * exotic value degrades to null/empty rather than failing the parse.
 */
export function readChatNoteFrontmatter(noteText: string): ChatNoteFrontmatter {
  const normalized = normalizeEol(noteText);
  if (!normalized.startsWith('---\n')) {
    return { ...EMPTY_FRONTMATTER };
  }
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) {
    return { ...EMPTY_FRONTMATTER };
  }
  const yaml = normalized.slice(4, end);
  const fields: Record<string, string> = {};
  for (const line of yaml.split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(line);
    if (match) {
      fields[match[1]] = stripQuotes(match[2]);
    }
  }
  const scalar = (key: string): string | null => {
    const value = fields[key];
    // Absent, empty, or an explicit YAML null (`null` / `~`) reads null.
    return value === undefined || value === '' || value === 'null' || value === '~'
      ? null
      : value;
  };
  return {
    kind: scalar('kind'),
    provider: scalar('provider'),
    model: scalar('model'),
    session: scalar('session'),
    title: scalar('title'),
    created: scalar('created'),
    updated: scalar('updated'),
    note: scalar('note'),
  };
}

/** Parses one ```drey-tool fence body line; null when it is not a tool line. */
function parseToolLine(line: string): ChatToolEntry | null {
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const call = obj['call'];
  const result = obj['result'];
  const edit = obj['edit'];
  if (call && typeof call === 'object' && !Array.isArray(call)) {
    const c = call as Record<string, unknown>;
    if (typeof c['name'] !== 'string' || c['name'] === '') {
      return null;
    }
    return {
      kind: 'call',
      id: typeof c['id'] === 'string' ? c['id'] : '',
      name: c['name'],
      arguments: c['arguments'] ?? '',
    };
  }
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    return {
      kind: 'result',
      id: typeof r['id'] === 'string' ? r['id'] : '',
      content: typeof r['content'] === 'string' ? r['content'] : String(r['content'] ?? ''),
    };
  }
  if (edit && typeof edit === 'object' && !Array.isArray(edit)) {
    const e = edit as Record<string, unknown>;
    if (typeof e['path'] !== 'string' || e['path'] === '') {
      return null;
    }
    return {
      kind: 'edit',
      path: e['path'],
      applied: e['applied'] === true,
      ...(typeof e['after'] === 'string' ? { after: e['after'] } : {}),
    };
  }
  return null;
}

/** Parses one ```drey-context fence body line; null when it is neither a citation nor a status. */
function parseContextLine(line: string): ChatContextEntry | ChatContextStatus | null {
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const status = obj['status'];
  if (typeof status === 'string') {
    if (status === 'empty' && typeof obj['floor'] === 'number' && Number.isFinite(obj['floor'])) {
      return { kind: 'empty', floor: obj['floor'] };
    }
    if (status === 'disabled') {
      return { kind: 'disabled' };
    }
    if (status === 'unregistered') {
      return { kind: 'unregistered' };
    }
    if (status === 'error' && typeof obj['message'] === 'string') {
      return { kind: 'error', message: obj['message'] };
    }
    return null;
  }
  const cite = obj['cite'];
  if (!cite || typeof cite !== 'object' || Array.isArray(cite)) {
    return null;
  }
  const c = cite as Record<string, unknown>;
  if (typeof c['path'] !== 'string' || c['path'] === '') {
    return null;
  }
  return {
    ...(typeof c['vault'] === 'string' && c['vault'] !== '' ? { vault: c['vault'] } : {}),
    path: c['path'],
    heading: typeof c['heading'] === 'string' ? c['heading'] : '',
    line: typeof c['line'] === 'number' ? c['line'] : 0,
  };
}

/** True when the line is exactly one attachment link (a wikilink or an image). */
export function isAttachmentLine(line: string): ChatNoteAttachment | null {
  const wiki = WIKILINK_LINE.exec(line.trim());
  if (wiki) {
    return { kind: 'note', path: wiki[1].trim() };
  }
  const image = IMAGE_LINE.exec(line.trim());
  if (image) {
    return { kind: 'image', path: image[2], alt: image[1] };
  }
  return null;
}

/**
 * Parses a chat note into its frontmatter and turns. Never throws: a file
 * without any turn heading yields an empty turn list (still a valid,
 * brand-new chat), malformed tool lines and meta comments are dropped,
 * and an unparseable attachment block stays prose.
 */
export function parseChatNote(noteText: string): ChatNoteView {
  const normalized = normalizeEol(noteText);
  const frontmatter = readChatNoteFrontmatter(normalized);

  // Body = after the closing frontmatter fence (or the whole text).
  // `bodyStart` keeps turn offsets ABSOLUTE in the note text so
  // `truncateFrom` / `appendEditOutcome` can slice the raw string.
  let body = normalized;
  let bodyStart = 0;
  if (normalized.startsWith('---\n')) {
    const end = normalized.indexOf('\n---', 4);
    if (end !== -1) {
      const afterFence = normalized.indexOf('\n', end + 1);
      bodyStart = afterFence === -1 ? normalized.length : afterFence + 1;
      body = afterFence === -1 ? '' : normalized.slice(bodyStart);
    }
  }

  const lines = body.split('\n');
  const turns: ChatNoteTurn[] = [];
  let current: { turn: ChatNoteTurn; raw: string[] } | null = null;

  const finish = (): void => {
    if (!current) {
      return;
    }
    const { turn, raw } = current;
    // Fences: ```drey-tool (calls/results/edits) and ```drey-context
    // (retrieved-vault citations) — content lines parsed in order.
    const tool: ChatToolEntry[] = [];
    const context: ChatContextEntry[] = [];
    let fenceTag: 'tool' | 'context' | null = null;
    const textLines: string[] = [];
    for (const line of raw) {
      const trimmed = line.trim();
      if (fenceTag === null && trimmed === '```' + TOOL_FENCE_TAG) {
        fenceTag = 'tool';
        continue;
      }
      if (fenceTag === null && trimmed === '```' + CONTEXT_FENCE_TAG) {
        fenceTag = 'context';
        continue;
      }
      if (fenceTag !== null && trimmed === '```') {
        fenceTag = null;
        continue;
      }
      if (fenceTag === 'tool') {
        const entry = parseToolLine(line);
        if (entry) {
          tool.push(entry);
        }
        continue;
      }
      if (fenceTag === 'context') {
        const entry = parseContextLine(line);
        if (entry && 'kind' in entry) {
          if (turn.contextStatus === null) {
            turn.contextStatus = entry; // first status line wins; we write one
          }
        } else if (entry) {
          context.push(entry);
        }
        continue;
      }
      if (META.test(trimmed)) {
        continue; // meta handled below
      }
      textLines.push(line);
    }
    turn.tool = tool;
    turn.context = context;

    // Meta comment (first ```<!-- drey: … -->``` in the raw segment).
    for (const line of raw) {
      const match = META.exec(line.trim());
      if (match) {
        try {
          const meta = JSON.parse(match[1]) as Record<string, unknown>;
          if (typeof meta['durationMs'] === 'number') {
            turn.meta.durationMs = meta['durationMs'];
          }
          if (typeof meta['model'] === 'string') {
            turn.meta.model = meta['model'];
          }
        } catch {
          // Hand-mangled meta — ignore.
        }
        break;
      }
      if (line.trim() !== '') {
        break; // only the lines directly under the heading count
      }
    }

    // Attachment block: trailing run of link-only lines on USER turns,
    // preceded by a blank line (or the whole segment). Trailing blank
    // lines are skipped first, then the link run is scanned backwards.
    if (turn.role === 'user') {
      let end = textLines.length;
      while (end > 0 && textLines[end - 1].trim() === '') {
        end--;
      }
      let cut = end;
      let allLinks = end > 0;
      while (cut > 0 && textLines[cut - 1].trim() !== '') {
        if (!isAttachmentLine(textLines[cut - 1])) {
          allLinks = false;
          break;
        }
        cut--;
      }
      const hasBlankBefore = cut === 0 || textLines[cut - 1].trim() === '';
      if (allLinks && cut < end && hasBlankBefore) {
        turn.attachments = textLines
          .slice(cut, end)
          .map((line) => isAttachmentLine(line))
          .filter((a): a is ChatNoteAttachment => a !== null);
        textLines.length = cut;
      }
    }

    turn.text = textLines.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
    turns.push(turn);
    current = null;
  };

  let offset = 0;
  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (heading) {
      finish();
      const turn: ChatNoteTurn = {
        role: heading[1] === 'User' ? 'user' : 'assistant',
        at: heading[2] ?? null,
        meta: {},
        text: '',
        attachments: [],
        tool: [],
        context: [],
        contextStatus: null,
        start: bodyStart + offset,
      };
      current = { turn, raw: [] };
    } else if (current) {
      current.raw.push(line);
    }
    offset += line.length + 1;
  }
  finish();

  return { frontmatter, turns };
}

/** Serialises one attachment link line. */
function attachmentLine(attachment: ChatNoteAttachment): string {
  return attachment.kind === 'note'
    ? `[[${attachment.path}]]`
    : `![${attachment.alt}](${attachment.path})`;
}

/** One `{"call":…}` / `{"result":…}` / `{"edit":…}` fence line. */
export function toolEntryLine(entry: ChatToolEntry): string {
  switch (entry.kind) {
    case 'call':
      return JSON.stringify({
        call: { id: entry.id, name: entry.name, arguments: entry.arguments },
      });
    case 'result':
      return JSON.stringify({ result: { id: entry.id, content: entry.content } });
    case 'edit':
      return JSON.stringify({
        edit: { path: entry.path, applied: entry.applied, ...(entry.after !== undefined ? { after: entry.after } : {}) },
      });
  }
}

/** One `{"cite":…}` fence line (```drey-context). */
export function contextEntryLine(entry: ChatContextEntry): string {
  return JSON.stringify({
    cite: {
      ...(entry.vault !== undefined ? { vault: entry.vault } : {}),
      path: entry.path,
      heading: entry.heading,
      line: entry.line,
    },
  });
}

/** One `{"status":…}` fence line (```drey-context) — the no-hits explanation. */
export function contextStatusLine(status: ChatContextStatus): string {
  switch (status.kind) {
    case 'empty':
      return JSON.stringify({ status: 'empty', floor: status.floor });
    case 'disabled':
      return JSON.stringify({ status: 'disabled' });
    case 'unregistered':
      return JSON.stringify({ status: 'unregistered' });
    case 'error':
      return JSON.stringify({ status: 'error', message: status.message });
  }
}

/**
 * Maps an LLM result's `toolTrace` (the provider tool loop's
 * `assistant(tool_calls)` / `tool` messages, in order) onto persisted
 * entries. Mid-round assistant prose is dropped (it is empty in practice;
 * the final answer is the turn text).
 */
export function toolEntriesFromTrace(trace: readonly ChatMessage[] | undefined): ChatToolEntry[] {
  if (!trace || trace.length === 0) {
    return [];
  }
  const entries: ChatToolEntry[] = [];
  for (const message of trace) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        entries.push({
          kind: 'call',
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
    } else if (message.role === 'tool') {
      entries.push({
        kind: 'result',
        id: message.tool_call_id ?? '',
        content: message.content ?? '',
      });
    }
  }
  return entries;
}

/** The heading line of a turn, exactly as it is written back. */
function headingOf(turn: Pick<ChatNoteTurn, 'role' | 'at'>): string {
  return `## ${turn.role === 'user' ? 'User' : 'Assistant'}${turn.at ? ` — ${turn.at}` : ''}`;
}

/**
 * Serialises one turn to Markdown. Layout: heading, meta comment
 * (assistant, when it has content), blank line, text, blank line +
 * attachment lines (user), then the ```drey-tool fence (when the turn has
 * tool entries).
 */
export function serializeTurn(turn: ChatNoteTurn): string {
  const out: string[] = [headingOf(turn)];
  const metaEntries = Object.entries(turn.meta).filter(([, v]) => v !== undefined);
  if (metaEntries.length > 0) {
    out.push(`<!-- drey: ${JSON.stringify(Object.fromEntries(metaEntries))} -->`);
  }
  if (turn.text !== '') {
    out.push('', turn.text);
  }
  if (turn.attachments.length > 0) {
    out.push('', ...turn.attachments.map(attachmentLine));
  }
  if (turn.tool.length > 0) {
    out.push('', '```' + TOOL_FENCE_TAG, ...turn.tool.map(toolEntryLine), '```');
  }
  if (turn.context.length > 0 || turn.contextStatus !== null) {
    out.push(
      '',
      '```' + CONTEXT_FENCE_TAG,
      ...(turn.contextStatus !== null ? [contextStatusLine(turn.contextStatus)] : []),
      ...turn.context.map(contextEntryLine),
      '```',
    );
  }
  return out.join('\n');
}

/**
 * Appends a turn to the note TEXT (no IO): raw concatenation, so anything
 * the user hand-wrote outside the turns survives. The caller writes the
 * result back and bumps `updated:`.
 */
export function appendTurn(noteText: string, turn: ChatNoteTurn): string {
  const base = noteText === '' ? '' : noteText.endsWith('\n') ? noteText : `${noteText}\n`;
  return `${base}\n${serializeTurn(turn)}\n`;
}

/** Appends an edit-outcome line to the LAST assistant turn's fence. */
export function appendEditOutcome(
  noteText: string,
  outcome: { path: string; applied: boolean; after?: string },
): string {
  const normalized = normalizeEol(noteText);
  const view = parseChatNote(normalized);
  let lastIndex = -1;
  for (let i = view.turns.length - 1; i >= 0; i--) {
    if (view.turns[i].role === 'assistant') {
      lastIndex = i;
      break;
    }
  }
  if (lastIndex === -1) {
    // No assistant turn to attach to — synthesize a minimal one.
    return appendTurn(noteText, {
      role: 'assistant',
      at: null,
      meta: {},
      text: `${EDIT_PROPOSAL_MARKER} \`${outcome.path}\`]`,
      attachments: [],
      tool: [
        { kind: 'edit', path: outcome.path, applied: outcome.applied, ...(outcome.after !== undefined ? { after: outcome.after } : {}) },
      ],
      context: [],
      contextStatus: null,
      start: 0,
    });
  }
  const line = toolEntryLine({
    kind: 'edit',
    path: outcome.path,
    applied: outcome.applied,
    ...(outcome.after !== undefined ? { after: outcome.after } : {}),
  });
  const next = view.turns[lastIndex + 1];
  const insertAt = next ? next.start : normalized.length;
  const segment = normalized.slice(0, insertAt);
  const rest = normalized.slice(insertAt);
  // The fence is the last block of the turn — insert before its closing ``` line.
  const fenceEnd = segment.lastIndexOf('\n```');
  if (fenceEnd !== -1) {
    return segment.slice(0, fenceEnd) + '\n' + line + segment.slice(fenceEnd) + rest;
  }
  // The turn has no fence yet (an edit proposal without tool rounds) — one goes at its end.
  return `${segment.replace(/\n+$/, '\n')}\n\`\`\`${TOOL_FENCE_TAG}\n${line}\n\`\`\`\n\n${rest.replace(/^\n+/, '')}`;
}

/**
 * Drops every turn from `turnIndex` on. Used by "restart from here" —
 * the caller also clears the frontmatter `session:` afterwards (truncated
 * history no longer matches the provider session). Offsets come from the
 * EOL-normalised text, so the slice runs on the normalised copy.
 */
export function truncateFrom(noteText: string, turnIndex: number): string {
  const normalized = normalizeEol(noteText);
  const turn = parseChatNote(normalized).turns[turnIndex];
  if (!turn) {
    return noteText;
  }
  return `${normalized.slice(0, turn.start).replace(/\n+$/, '')}\n`;
}

/** `2026-09-13` + slug → `chats/2026/09/2026-09-13-<slug>.md` (mirrors `daily/` nesting). */
export function chatNotePathFor(dateStr: string, slug: string): string {
  const [year, month] = dateStr.split('-');
  return `${CHATS_DIR}/${year}/${month}/${dateStr}-${slug}.md`;
}

/**
 * First free path for a new chat: `-2`, `-3` … against the sibling names
 * (NOT copy-style " copy" — a chat note's name should stay a clean slug).
 */
export function uniqueChatPath(path: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  if (!taken.has(path)) {
    return path;
  }
  const dot = path.lastIndexOf('.');
  const stem = dot === -1 ? path : path.slice(0, dot);
  const ext = dot === -1 ? '' : path.slice(dot);
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

/**
 * Chat title → kebab-case slug (the meeting-slug algorithm, copied —
 * cross-plugin imports are banned). Falls back to `'chat'`.
 */
const LEADING_NOISE =
  /^\s*(?:re|fw|fwd|aw|wg|updated|accepted|declined|tentative|canceled|cancelled)\s*:\s*/i;
const COMBINING_MARKS = /[̀-ͯ]/g;
const MAX_SLUG_LENGTH = 60;

export function slugifyChatTitle(title: string): string {
  let text = (title ?? '').toLowerCase();
  let stripped = text.replace(LEADING_NOISE, '');
  while (stripped !== text) {
    text = stripped;
    stripped = text.replace(LEADING_NOISE, '');
  }
  const slug = text
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (slug.length <= MAX_SLUG_LENGTH) {
    return slug === '' ? 'chat' : slug;
  }
  const head = slug.slice(0, MAX_SLUG_LENGTH);
  const lastDash = head.lastIndexOf('-');
  const capped = (lastDash > 0 ? head.slice(0, lastDash) : head).replace(/-$/, '');
  return capped === '' ? 'chat' : capped;
}
