/**
 * What a worker changed in its working copy of a store ticket, taken back
 * into the ticket as it stands now (D-30, E14-5c): a store ticket has no file
 * a worker may edit, so the run hands it a copy and the runner `put`s the
 * changed chapters back inside its claim. Pure text; the file reads and the
 * `put` belong to the runner.
 *
 * Chapter by chapter, against the copy the worker was given, so an owner's edit
 * to another chapter during the run stands:
 * - a chapter the worker changed or added replaces the ticket's own, or goes
 *   before `## Verlauf` / `## Log` when the ticket has none;
 * - the Log takes the worker's new lines, at its end;
 * - the frontmatter, the text before the first chapter and `## Verlauf` are
 *   the board's and the runner's: a worker's edit there does not count;
 * - a chapter the worker removed stays.
 */
import { maskFences } from '../../../../shared/markdown/fences';

const NL = '\n';
const LOG = 'Log';
const VERLAUF = 'Verlauf';

interface Chapter {
  readonly title: string;
  /** Index of the `## ` line. */
  readonly start: number;
  /** Index after the chapter's last line. */
  readonly end: number;
}

const lf = (text: string): string => text.replace(/\r\n/g, NL);

function chaptersOf(lines: readonly string[], scan: readonly string[]): Chapter[] {
  const starts: { title: string; start: number }[] = [];
  scan.forEach((line, index) => {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      starts.push({ title: heading[1]!, start: index });
    }
  });
  return starts.map((one, i) => ({ ...one, end: starts[i + 1]?.start ?? lines.length }));
}

function parse(text: string): { lines: string[]; chapters: Chapter[] } {
  const normal = lf(text);
  const lines = normal.split(NL);
  return { lines, chapters: chaptersOf(lines, maskFences(normal).split(NL)) };
}

/** The chapter's text without the blank lines around its end. */
function body(lines: readonly string[], chapter: Chapter): string {
  return lines.slice(chapter.start, chapter.end).join(NL).trimEnd();
}

export function mergeWorkerChapters(given: string, worker: string, current: string): string {
  const base = parse(given);
  const edited = parse(worker);
  let result = lf(current);
  for (const chapter of edited.chapters) {
    if (chapter.title === VERLAUF) {
      continue;
    }
    const text = body(edited.lines, chapter);
    const before = base.chapters.find((c) => c.title === chapter.title);
    const old = before === undefined ? null : body(base.lines, before);
    if (text === old) {
      continue;
    }
    result = chapter.title === LOG ? appendLogLines(result, old, text) : replaceChapter(result, chapter.title, text);
  }
  return result;
}

function replaceChapter(text: string, title: string, chapterText: string): string {
  const { lines, chapters } = parse(text);
  const own = chapters.find((c) => c.title === title);
  if (own !== undefined) {
    return [...lines.slice(0, own.start), ...chapterText.split(NL), '', ...lines.slice(own.end)].join(NL);
  }
  const next = chapters.find((c) => c.title === VERLAUF) ?? chapters.find((c) => c.title === LOG);
  if (next !== undefined) {
    return [...lines.slice(0, next.start), ...chapterText.split(NL), '', ...lines.slice(next.start)].join(NL);
  }
  return `${text.trimEnd()}${NL}${NL}${chapterText}${NL}`;
}

function appendLogLines(text: string, oldLog: string | null, newLog: string): string {
  const known = new Set((oldLog ?? '').split(NL));
  const added = newLog
    .split(NL)
    .slice(1)
    .filter((line) => line.trim() !== '' && !known.has(line));
  if (added.length === 0) {
    return text;
  }
  const { lines, chapters } = parse(text);
  const log = chapters.find((c) => c.title === LOG);
  if (log === undefined) {
    return `${text.trimEnd()}${NL}${NL}## ${LOG}${NL}${NL}${added.join(NL)}${NL}`;
  }
  const kept = body(lines, log).split(NL);
  return [...lines.slice(0, log.start), ...kept, ...added, '', ...lines.slice(log.end)].join(NL);
}
