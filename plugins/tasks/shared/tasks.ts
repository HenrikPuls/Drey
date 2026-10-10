/**
 * Pure task scanning + line editing, shared by the plugin's main-side
 * `TaskIndex` and its renderer panel (so an on-disk task and one read from
 * an open buffer are shaped identically).
 *
 * Two kinds of task line are recognised:
 *
 *  - **checkbox** -- a GFM task list item (`- [ ]` / `- [x]`, also `*` / `+`
 *    bullets, any indentation). `done` is the `[x]`.
 *  - **tag** -- any line carrying the reserved `#task` marker (`#task` and
 *    its `#task/*` subtree are structural, never ordinary tags). A tag task
 *    with no checkbox is `done` when the line also carries `#task/done`.
 *
 * A line that is *both* a checkbox and `#task` is reported once, as
 * `kind: 'checkbox'`, with `done` taken from the box.
 *
 * Fenced code blocks (``` / ~~~) are skipped so a checkbox or `#task`
 * written inside an example does not become a real task.
 *
 * Inline metadata (Obsidian Tasks-compatible emoji, req-37): a due date
 * `📅 YYYY-MM-DD` and a priority glyph (`🔺` highest, `⏫` high, `🔽` low;
 * none = normal) may sit anywhere on the task line. Both are parsed into
 * the record and STRIPPED from `text`, so the toggle resolution
 * (`resolveTaskLine`, text+kind matching) is unaffected by metadata edits
 * -- and a vault stays readable/writable by Obsidian's Tasks plugin. The
 * tokens are human-legible annotations, not machine ids (ADR-0033's
 * rejection of `#task/id:` stands).
 *
 * Read compat (57a): the meeting import's text form — a `due:` /
 * `done:` word before an ISO date — carries the same metadata and is
 * parsed + stripped the same way (`done:` marks the task done). It is
 * never written back: the setters stay `📅`-shaped, so a line edited by
 * the pickers gains the emoji form while its text prefix goes away.
 *
 * Completion date (57d): Obsidian Tasks' done date `✅ YYYY-MM-DD` is
 * parsed into `completed` and stripped from `text` like the other tokens
 * (the text-form `done:` date feeds the same field). It is WRITTEN by the
 * done toggle (`setDoneOnLine`) and removed on reopen — the date alone
 * never marks a task done; the box / `#task/done` decides.
 */

import { extractInlineTags, splitSections, tagSetMatches } from './support.js';

export type TaskKind = 'checkbox' | 'tag';

/** The explicit priority levels a glyph may name; `null` means normal. */
export type TaskPriority = 'highest' | 'high' | 'low';

/** One task line found in a note. */
export interface TaskRecord {
  /** Vault-relative path of the note. */
  path: string;
  /**
   * Owning vault id (ADR-0051). `''` only for scans that are not
   * vault-bound (the panel's document scope over a never-located scratch
   * tab); every index/panel record carries the real id.
   */
  vaultId: string;
  /** 1-based line the task sits on. */
  line: number;
  /** The task text: list marker, checkbox, `#task*` markers and metadata stripped. */
  text: string;
  done: boolean;
  kind: TaskKind;
  /** Nearest heading (any level) above the task, or `null` before the first one. */
  heading: string | null;
  /**
   * Distinct inline `#tags` of the heading-section the task sits in,
   * lower-cased (same unit the tag search reports on). Includes a tag
   * written directly on the task line. Empty when the section carries none.
   */
  tags: readonly string[];
  /** Due date as written (`YYYY-MM-DD`), or `null` without a `📅` token. */
  due: string | null;
  /** The line's priority glyph, or `null` (= normal, no glyph). */
  priority: TaskPriority | null;
  /**
   * Completion date as written (`✅ YYYY-MM-DD` or the text-form `done:`
   * date), or `null`. Absent on records persisted before SDK 1.13.
   */
  completed?: string | null;
}

const FENCE = /^[ \t]*(```|~~~)/;
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
/** Capturing: 1 = up to and incl. the `[`, 2 = the box char, 3 = the rest. */
const CHECKBOX = /^([ \t]*[-*+][ \t]+\[)([ xX])(\].*)$/;
/** The `#task` marker (optionally `#task/…` nested), whitespace-delimited. */
const TASK_MARKER = /(^|\s)#task(?:\/[\p{L}\p{N}_-]+)*(?=\s|$)/u;
/** The `#task/done` completion marker. */
const TASK_DONE = /(^|\s)#task\/done(?=\s|$)/u;

/**
 * The Obsidian-Tasks metadata tokens, whitespace-delimited (see the file
 * header): the due `📅 YYYY-MM-DD` and the priority glyphs. Each pattern
 * exists twice -- global for replace-all stripping, non-global for the
 * first-match parse (a global regex's `exec` carries `lastIndex` between
 * calls, which would silently skip tokens). The strip patterns also eat
 * ONE trailing separator, so removal never leaves a double gap and never
 * touches anything else on the line.
 */
const DUE_TOKEN = /(^|\s)📅[ \t]+\d{4}-\d{2}-\d{2}(?:[ \t]+(?=\S)|[ \t]*(?=$))/gu;
const DUE_ONE = /(^|\s)📅[ \t]+(\d{4}-\d{2}-\d{2})(?=\s|$)/u;
/**
 * The meeting-import text form (read compat): a `due: YYYY-MM-DD` /
 * `done: YYYY-MM-DD` word carries the same metadata as the emoji tokens.
 * Parsed into the record and stripped from `text`, but never WRITTEN —
 * the setters stay `📅`-shaped (Obsidian-Tasks compatibility, req-37).
 * `#task/done` (no colon) is the unrelated completion marker and does not
 * match these patterns.
 */
const DUE_TEXT_ONE = /(^|\s)due:[ \t]*(\d{4}-\d{2}-\d{2})(?=\s|$)/u;
const DUE_TEXT_TOKEN = /(^|\s)due:[ \t]*\d{4}-\d{2}-\d{2}(?:[ \t]+(?=\S)|[ \t]*(?=$))/gu;
const DONE_TEXT_ONE = /(^|\s)done:[ \t]*(\d{4}-\d{2}-\d{2})(?=\s|$)/u;
const DONE_TEXT_TOKEN = /(^|\s)done:[ \t]*\d{4}-\d{2}-\d{2}(?:[ \t]+(?=\S)|[ \t]*(?=$))/gu;
/** The Obsidian-Tasks done date `✅ YYYY-MM-DD` (an emoji variation selector is tolerated). */
const DONE_DATE_ONE = /(^|\s)✅️?[ \t]+(\d{4}-\d{2}-\d{2})(?=\s|$)/u;
const DONE_DATE_TOKEN = /(^|\s)✅️?[ \t]+\d{4}-\d{2}-\d{2}(?:[ \t]+(?=\S)|[ \t]*(?=$))/gu;
const PRIORITY_TOKEN = /(^|\s)([🔺⏫🔽])(?:[ \t]+(?=\S)|[ \t]*(?=$))/gu;
const PRIORITY_ONE = /(^|\s)([🔺⏫🔽])(?=\s|$)/u;
const PRIORITY_OF: Readonly<Record<string, TaskPriority>> = {
  '🔺': 'highest',
  '⏫': 'high',
  '🔽': 'low',
};
const GLYPH_OF: Readonly<Record<TaskPriority, string>> = {
  highest: '🔺',
  high: '⏫',
  low: '🔽',
};
/** The exact shape a due date must have to be set (the parse stays tolerant). */
const DUE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** The priority a glyph names, or `null` for `normal` (no glyph). */
export function priorityOfGlyph(glyph: string): TaskPriority | null {
  return PRIORITY_OF[glyph] ?? null;
}

/** The line token a priority renders as. */
export function glyphOfPriority(priority: TaskPriority): string {
  return GLYPH_OF[priority];
}

/** Today as `YYYY-MM-DD`, in the local timezone (the due badge's baseline). */
export function todayIso(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** How a due date sits against `today` (defaults to the real today). */
export type DueState = 'overdue' | 'today' | 'future';

/** Classifies a `YYYY-MM-DD` due date against a baseline date. */
export function dueState(due: string, today = todayIso()): DueState {
  if (due < today) {
    return 'overdue';
  }
  return due === today ? 'today' : 'future';
}

/**
 * Span patterns for the token finder: like the strip patterns above but
 * WITH the value captured (the date / the glyph), so click targets and
 * decorations can be derived from a line.
 */
const DUE_SPAN = /(^|\s)📅[ \t]+(\d{4}-\d{2}-\d{2})(?=\s|$)/gu;
const PRIORITY_SPAN = /(^|\s)([🔺⏫🔽])(?=\s|$)/gu;

/** True when `line` parses as a task line (a checkbox or carries `#task`). */
export function isTaskLine(line: string): boolean {
  return CHECKBOX.test(line) || TASK_MARKER.test(line);
}

/** One metadata token's span on a line (0-based, `to` exclusive). */
export interface TaskTokenSpan {
  from: number;
  to: number;
  kind: 'due' | 'priority';
  /** The ISO date, or the priority name the glyph stands for. */
  value: string;
}

/**
 * The metadata token spans on `line`, left to right (empty when the line
 * parses as no task). Spans start after the separating whitespace, so a
 * decoration/click target covers exactly the token text.
 */
export function taskLineTokens(line: string): TaskTokenSpan[] {
  if (!isTaskLine(line)) {
    return [];
  }
  const out: TaskTokenSpan[] = [];
  for (const match of line.matchAll(DUE_SPAN)) {
    out.push({
      from: match.index + match[1].length,
      to: match.index + match[0].length,
      kind: 'due',
      value: match[2],
    });
  }
  for (const match of line.matchAll(PRIORITY_SPAN)) {
    const value = PRIORITY_OF[match[2]] ?? null;
    if (value !== null) {
      out.push({
        from: match.index + match[1].length,
        to: match.index + match[0].length,
        kind: 'priority',
        value,
      });
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

/**
 * Splits the metadata tokens off a task line's text: the first `📅` date
 * (or the text-form `due:` date) becomes `due`, the first priority glyph
 * becomes `priority`, a text-form `done:` date marks the task done, and
 * every such token is removed from the returned text (gap collapsed, the
 * same normalization `stripTaskMarkers` applies).
 */
function splitTaskMeta(text: string): {
  text: string;
  due: string | null;
  priority: TaskPriority | null;
  done: boolean;
  completed: string | null;
} {
  const due = DUE_ONE.exec(text)?.[2] ?? DUE_TEXT_ONE.exec(text)?.[2] ?? null;
  const glyph = PRIORITY_ONE.exec(text)?.[2] ?? null;
  const doneText = DONE_TEXT_ONE.exec(text);
  // The strip patterns eat one trailing separator, so nothing doubles up.
  const stripped = text
    .replace(DUE_TOKEN, '$1')
    .replace(DUE_TEXT_TOKEN, '$1')
    .replace(DONE_TEXT_TOKEN, '$1')
    .replace(DONE_DATE_TOKEN, '$1')
    .replace(PRIORITY_TOKEN, '$1')
    .trim();
  return {
    text: stripped,
    due,
    priority: glyph === null ? null : (PRIORITY_OF[glyph] ?? null),
    done: doneText !== null,
    completed: DONE_DATE_ONE.exec(text)?.[2] ?? doneText?.[2] ?? null,
  };
}

/** Strips a leading list bullet (`- `, `* `, `+ `) and surrounding whitespace. */
function stripBullet(line: string): string {
  return line.replace(/^[ \t]*[-*+][ \t]+/, '').trim();
}

/** Drops every `#task` / `#task/…` token and collapses the gap it leaves. */
function stripTaskMarkers(text: string): string {
  return text
    .replace(/(^|\s)#task(?:\/[\p{L}\p{N}_-]+)*(?=\s|$)/gu, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * The heading-sections of `content` as `[startLine, endLine, tags]`, so a
 * task line can be mapped to the inline tags of the section it sits in.
 * Reuses `splitSections` -- the exact unit the tag search reports on.
 */
function sectionTagRanges(
  content: string,
): { start: number; end: number; tags: readonly string[] }[] {
  const sections = splitSections(content);
  return sections.map((s, i) => ({
    start: s.line,
    end: i + 1 < sections.length ? sections[i + 1].line - 1 : Number.MAX_SAFE_INTEGER,
    tags: extractInlineTags(`${s.heading}\n${s.text}`),
  }));
}

/** Every task line in `content`, in document order. */
export function scanTasks(path: string, content: string, vaultId = ''): TaskRecord[] {
  const lines = content.split('\n');
  const out: TaskRecord[] = [];
  const ranges = sectionTagRanges(content);
  const tagsForLine = (ln: number): readonly string[] =>
    ranges.find((r) => ln >= r.start && ln <= r.end)?.tags ?? [];
  let inFence = false;
  let heading: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    if (FENCE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }

    const h = HEADING.exec(raw);
    if (h) {
      heading = h[2];
      continue;
    }

    const box = CHECKBOX.exec(raw);
    if (box) {
      const meta = splitTaskMeta(stripTaskMarkers(box[3].slice(1).trim()));
      out.push({
        path,
        vaultId,
        line: i + 1,
        text: meta.text,
        done: box[2].toLowerCase() === 'x' || meta.done,
        kind: 'checkbox',
        heading,
        tags: tagsForLine(i + 1),
        due: meta.due,
        priority: meta.priority,
        completed: meta.completed,
      });
      continue;
    }

    if (TASK_MARKER.test(raw)) {
      const meta = splitTaskMeta(stripTaskMarkers(stripBullet(raw)));
      out.push({
        path,
        vaultId,
        line: i + 1,
        text: meta.text,
        done: TASK_DONE.test(raw) || meta.done,
        kind: 'tag',
        heading,
        tags: tagsForLine(i + 1),
        due: meta.due,
        priority: meta.priority,
        completed: meta.completed,
      });
    }
  }

  return out;
}

/**
 * Returns `content` with the done-state of the task on 1-based `line`
 * forced to `done`. A checkbox line flips `[ ]` ⇄ `[x]`; a `#task` line
 * without a checkbox gains or loses a trailing ` #task/done`. Completing
 * also stamps the completion date `✅ today`; reopening removes it (57d).
 * If the line is out of range or does not parse as a task, `content` is
 * returned unchanged.
 */
export function setDoneOnLine(
  content: string,
  line: number,
  done: boolean,
  today = todayIso(),
): string {
  const lines = content.split('\n');
  const i = line - 1;
  if (i < 0 || i >= lines.length) {
    return content;
  }
  const next = setDoneOnLineText(lines[i], done, today);
  if (next === lines[i]) {
    return content;
  }
  lines[i] = next;
  return lines.join('\n');
}

/**
 * The single-line form of {@link setDoneOnLine}: `line` with its done
 * state forced to `done`. A line already in that state (or no task line)
 * comes back unchanged — a legacy done task never gains a date it did not
 * earn today.
 */
export function setDoneOnLineText(line: string, done: boolean, today = todayIso()): string {
  const box = CHECKBOX.exec(line);
  if (box) {
    if ((box[2].toLowerCase() === 'x') === done) {
      return line;
    }
    return withCompletionDate(`${box[1]}${done ? 'x' : ' '}${box[3]}`, done ? today : null);
  }

  if (TASK_MARKER.test(line)) {
    if (TASK_DONE.test(line) === done) {
      return line;
    }
    const bare = withCompletionDate(
      line.replace(TASK_DONE, '$1').replace(/[ \t]+$/, ''),
      done ? today : null,
    );
    // The date sits before the marker, so `#task/done` stays line-final.
    return done ? `${bare} #task/done` : bare;
  }

  return line;
}

/**
 * Brings the completion date of a task line in sync with its CURRENT done
 * state (the box / `#task/done` was flipped by someone else — the editor's
 * toggle commands): a done line without a date gains `✅ today`, an open
 * line loses its date. Any other line comes back unchanged.
 */
export function syncCompletionDateOnLineText(line: string, today = todayIso()): string {
  const box = CHECKBOX.exec(line);
  if (box) {
    const done = box[2].toLowerCase() === 'x';
    if (done && DONE_DATE_ONE.test(line)) {
      return line;
    }
    return withCompletionDate(line, done ? today : null);
  }
  return line;
}

/** `line` with its `✅` date replaced by `date`, or removed (`null`). */
function withCompletionDate(line: string, date: string | null): string {
  if (date === null && line.search(DONE_DATE_TOKEN) === -1) {
    return line;
  }
  const bare = line.replace(DONE_DATE_TOKEN, '$1').replace(/[ \t]+$/, '');
  return date === null ? bare : `${bare} ✅ ${date}`;
}

/**
 * When a task counts as completed, for the `completed` view: the date
 * written on the line, else the first `YYYY-MM-DD` in the note's file
 * name (a daily or dated meeting note — the legacy approximation for
 * tasks ticked before 57d), else `null`. Read-only; never written back.
 */
export function completionKey(task: {
  readonly path: string;
  readonly completed?: string | null;
}): string | null {
  if (task.completed !== undefined && task.completed !== null) {
    return task.completed;
  }
  const name = task.path.slice(task.path.lastIndexOf('/') + 1);
  return /\d{4}-\d{2}-\d{2}/.exec(name)?.[0] ?? null;
}

/**
 * Returns `content` with the due date of the task on 1-based `line` set to
 * `due` (`YYYY-MM-DD`) or removed (`null`). A missing token is appended at
 * the line's end (Obsidian keeps the token's position; we append —
 * deterministic, and the text is unaffected either way since parsing
 * strips metadata). A malformed date, an out-of-range line or a line that
 * does not parse as a task leaves `content` unchanged.
 */
export function setDueOnLine(content: string, line: number, due: string | null): string {
  if (due !== null && !DUE_SHAPE.test(due)) {
    return content;
  }
  return setTokenOnLine(content, line, DUE_TOKEN, due === null ? null : `📅 ${due}`);
}

/**
 * Returns `content` with the priority glyph of the task on 1-based `line`
 * set to `priority` or removed (`null` = normal). Same append / guard
 * rules as {@link setDueOnLine}.
 */
export function setPriorityOnLine(
  content: string,
  line: number,
  priority: TaskPriority | null,
): string {
  return setTokenOnLine(
    content,
    line,
    PRIORITY_TOKEN,
    priority === null ? null : glyphOfPriority(priority),
  );
}

/** The one line-level token splice both setters share (see their docs). */
function setTokenOnLine(
  content: string,
  line: number,
  token: RegExp,
  tokenText: string | null,
): string {
  const lines = content.split('\n');
  const i = line - 1;
  if (i < 0 || i >= lines.length) {
    return content;
  }
  const original = lines[i];
  // Guard the same way setDoneOnLine does: metadata is only ever written
  // onto a line that parses as a task.
  if (!CHECKBOX.test(original) && !TASK_MARKER.test(original)) {
    return content;
  }
  const had = original.search(token) !== -1;
  if (tokenText === null && !had) {
    return content;
  }
  // The removal pattern eats one trailing separator, so the rest of the
  // line (indentation included) stays byte-identical; a line-final token
  // only leaves its lead separator behind, which the trim below drops.
  let next = original.replace(token, '$1');
  if (tokenText !== null) {
    next = `${next.replace(/[ \t]+$/, '')} ${tokenText}`;
  } else {
    next = next.replace(/[ \t]+$/, '');
  }
  if (next === original) {
    return content;
  }
  lines[i] = next;
  return lines.join('\n');
}

/**
 * The line a row toggle should act on in `content`. A panel row's recorded
 * line goes STALE the moment the note is saved with frontmatter growth —
 * the pipeline's `created:`/`updated:` bump inserts lines above the body,
 * shifting every task down — and a toggle against the old number then
 * lands on a shifted line, where it silently no-ops (or worse, flips a
 * neighbouring task). So: the exact line when a task still sits there,
 * otherwise the one line carrying the SAME text and kind. A shift with
 * SEVERAL identical candidates is ambiguous — the recorded line can no
 * longer tell the twins apart — so this returns `null` rather than
 * guessing; the caller skips the toggle (never mis-ticks a twin).
 * `null` also when the task is gone from the content entirely.
 */
export function resolveTaskLine(content: string, task: TaskRecord): number | null {
  let found: TaskRecord | null = null;
  let ambiguous = false;
  for (const candidate of scanTasks(task.path, content)) {
    if (candidate.text !== task.text || candidate.kind !== task.kind) {
      continue;
    }
    if (candidate.line === task.line) {
      return candidate.line;
    }
    if (found !== null) {
      ambiguous = true;
    }
    found = candidate;
  }
  return found !== null && !ambiguous ? found.line : null;
}

/* ------------------------------------------------------------------ *
 * Deterministic task views (57c): the comparators and filter matching
 * the panel and the TaskQueryProvider share — one implementation, so
 * the assistant block and the Tasks panel always agree on order and
 * filtering semantics.
 * ------------------------------------------------------------------ */

/** The subset of a record the view comparators need. */
export interface TaskViewRecord {
  readonly path: string;
  readonly line: number;
  readonly due: string | null;
  readonly priority: TaskPriority | null;
  readonly completed?: string | null;
}

/**
 * The list orders: file order, due asc, priority, the due-dominant
 * composite, or completion date newest first.
 */
export type TaskViewSort = 'file' | 'due' | 'priority' | 'importance' | 'completed';

/** Canonical location tie-break in every sort: path, then line. */
export function byLocation(a: TaskViewRecord, b: TaskViewRecord): number {
  return a.path.localeCompare(b.path) || a.line - b.line;
}

/** The sort rank of a priority: highest, high, normal, low. */
export function priorityRank(task: TaskViewRecord): number {
  switch (task.priority) {
    case 'highest':
      return 0;
    case 'high':
      return 1;
    case null:
      return 2;
    case 'low':
      return 3;
  }
}

/** Due ascending (ISO orders lexicographically), undated last, ties by location. */
export function byDue(a: TaskViewRecord, b: TaskViewRecord): number {
  if (a.due === b.due) {
    return byLocation(a, b);
  }
  return a.due !== null && (b.due === null || a.due < b.due) ? -1 : 1;
}

/** The full comparator for one view sort (ties always fall back to location). */
export function compareTasks(a: TaskViewRecord, b: TaskViewRecord, sort: TaskViewSort): number {
  switch (sort) {
    case 'due':
      return byDue(a, b);
    case 'priority':
      return priorityRank(a) - priorityRank(b) || byLocation(a, b);
    case 'importance':
      // Due first — dated before undated, then ascending (overdue
      // naturally leads) — then priority decides WITHIN the undated
      // group too, then the canonical location order. (Plain `byDue`
      // would break due ties by location before priority could speak.)
      if (a.due !== b.due) {
        if (a.due === null) {
          return 1;
        }
        if (b.due === null) {
          return -1;
        }
        return a.due < b.due ? -1 : 1;
      }
      return priorityRank(a) - priorityRank(b) || byLocation(a, b);
    case 'completed': {
      // Newest completion first, undated last (57d).
      const ka = completionKey(a);
      const kb = completionKey(b);
      if (ka === kb) {
        return byLocation(a, b);
      }
      return ka !== null && (kb === null || ka > kb) ? -1 : 1;
    }
    case 'file':
      return byLocation(a, b);
  }
}

/** Sorts a copy; the input list is never mutated. */
export function sortTaskRecords<T extends TaskViewRecord>(list: readonly T[], sort: TaskViewSort): T[] {
  return [...list].sort((a, b) => compareTasks(a, b, sort));
}

/** The text/tag/overdue restrictions a task query may carry (SDK 1.12 subset). */
export interface TaskViewFilter {
  /** Whitespace-split terms that must all appear in the task text + heading. */
  readonly text?: string;
  /** One tag the task's section must carry — exact or namespace ancestor. */
  readonly tag?: string;
  /** Only tasks with a due date before `today`. */
  readonly overdue?: boolean;
  /** Only tasks completed on or after this `YYYY-MM-DD` (see `completionKey`). */
  readonly completedSince?: string;
}

/**
 * Whether one record satisfies the text/tag/overdue restrictions. The
 * same semantics as the panel's free-text/tag fields (AND terms,
 * namespace-aware tag match) — extracted here so the provider answers
 * assistant/MCP queries with exactly what the Tasks panel would show.
 */
export function taskMatchesFilter(
  task: Pick<TaskRecord, 'text' | 'heading' | 'tags' | 'due'> &
    Partial<Pick<TaskRecord, 'path' | 'completed'>>,
  filter: TaskViewFilter,
  today: string,
): boolean {
  if (filter.overdue === true && !(task.due !== null && task.due < today)) {
    return false;
  }
  if (filter.completedSince !== undefined) {
    const key = completionKey({ path: task.path ?? '', completed: task.completed });
    if (key === null || key < filter.completedSince) {
      return false;
    }
  }
  if (filter.tag !== undefined) {
    const wanted = filter.tag.trim().replace(/^#/, '').toLowerCase();
    if (wanted === '' || !tagSetMatches(new Set(task.tags), wanted)) {
      return false;
    }
  }
  if (filter.text !== undefined) {
    const terms = filter.text
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t !== '');
    const hay = `${task.text}\n${task.heading ?? ''}`.toLowerCase();
    if (!terms.every((term) => hay.includes(term))) {
      return false;
    }
  }
  return true;
}
