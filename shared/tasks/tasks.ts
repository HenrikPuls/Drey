/**
 * Pure task scanning + line editing, shared by the main-process `TaskIndex`
 * and the renderer's `TaskService` (so an on-disk task and one read from an
 * open buffer are shaped identically).
 *
 * Two kinds of task line are recognised:
 *
 *  - **checkbox** -- a GFM task list item (`- [ ]` / `- [x]`, also `*` / `+`
 *    bullets, any indentation). `done` is the `[x]`.
 *  - **tag** -- any line carrying the reserved `#task` marker (see
 *    `shared/tags/tags.ts`: `#task` and its `#task/*` subtree are structural,
 *    never ordinary tags). A tag task with no checkbox is `done` when the
 *    line also carries `#task/done`.
 *
 * A line that is *both* a checkbox and `#task` is reported once, as
 * `kind: 'checkbox'`, with `done` taken from the box.
 *
 * Fenced code blocks (``` / ~~~) are skipped so a checkbox or `#task`
 * written inside an example does not become a real task.
 */

import { extractInlineTags, splitSections } from '../tags';

export type TaskKind = 'checkbox' | 'tag';

/** One task line found in a note. */
export interface TaskRecord {
  /** Vault-relative path of the note. */
  path: string;
  /** 1-based line the task sits on. */
  line: number;
  /** The task text: list marker, checkbox and `#task*` markers stripped. */
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
}

const FENCE = /^[ \t]*(```|~~~)/;
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
/** Capturing: 1 = up to and incl. the `[`, 2 = the box char, 3 = the rest. */
const CHECKBOX = /^([ \t]*[-*+][ \t]+\[)([ xX])(\].*)$/;
/** The `#task` marker (optionally `#task/…` nested), whitespace-delimited. */
const TASK_MARKER = /(^|\s)#task(?:\/[\p{L}\p{N}_-]+)*(?=\s|$)/u;
/** The `#task/done` completion marker. */
const TASK_DONE = /(^|\s)#task\/done(?=\s|$)/u;

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
function sectionTagRanges(content: string): { start: number; end: number; tags: readonly string[] }[] {
  const sections = splitSections(content);
  return sections.map((s, i) => ({
    start: s.line,
    end: i + 1 < sections.length ? sections[i + 1].line - 1 : Number.MAX_SAFE_INTEGER,
    tags: extractInlineTags(`${s.heading}\n${s.text}`),
  }));
}

/** Every task line in `content`, in document order. */
export function scanTasks(path: string, content: string): TaskRecord[] {
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
      out.push({
        path,
        line: i + 1,
        text: stripTaskMarkers(box[3].slice(1).trim()),
        done: box[2].toLowerCase() === 'x',
        kind: 'checkbox',
        heading,
        tags: tagsForLine(i + 1),
      });
      continue;
    }

    if (TASK_MARKER.test(raw)) {
      out.push({
        path,
        line: i + 1,
        text: stripTaskMarkers(stripBullet(raw)),
        done: TASK_DONE.test(raw),
        kind: 'tag',
        heading,
        tags: tagsForLine(i + 1),
      });
    }
  }

  return out;
}

/**
 * Returns `content` with the done-state of the task on 1-based `line`
 * forced to `done`. A checkbox line flips `[ ]` ⇄ `[x]`; a `#task` line
 * without a checkbox gains or loses a trailing ` #task/done`. If the line
 * is out of range or does not parse as a task, `content` is returned
 * unchanged.
 */
export function setDoneOnLine(content: string, line: number, done: boolean): string {
  const lines = content.split('\n');
  const i = line - 1;
  if (i < 0 || i >= lines.length) {
    return content;
  }

  const original = lines[i];

  const box = CHECKBOX.exec(original);
  if (box) {
    const next = `${box[1]}${done ? 'x' : ' '}${box[3]}`;
    if (next === original) {
      return content;
    }
    lines[i] = next;
    return lines.join('\n');
  }

  if (TASK_MARKER.test(original)) {
    const has = TASK_DONE.test(original);
    if (done === has) {
      return content;
    }
    lines[i] = done
      ? `${original.replace(/[ \t]+$/, '')} #task/done`
      : original.replace(TASK_DONE, '$1').replace(/[ \t]+$/, '');
    return lines.join('\n');
  }

  return content;
}
