/**
 * Local copies of the two pure tag helpers `scanTasks` needs
 * (`splitSections`, `extractInlineTags`) plus `tagSetMatches` for the
 * Tasks panel's tag filter.
 *
 * TEMPORARY duplication (ADR-0044 stage 5): the originals moved into the
 * Tags plugin (`plugins/tags/shared/`), but the Tasks feature is still
 * base until stage 6 — when it converts, this file merges into the tasks
 * plugin and the duplication disappears. Keep in sync until then.
 */

/** Splits a Markdown body into heading-delimited sections (see Tags plugin). */
export interface Section {
  heading: string;
  level: number;
  line: number;
  text: string;
}

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^[ \t]*(```|~~~)/;

export function splitSections(body: string): Section[] {
  const lines = body.split('\n');
  const sections: Section[] = [];
  let heading = '';
  let level = 0;
  let startLine = 1;
  let buf: string[] = [];
  let inFence = false;

  const flush = (): void => {
    const text = buf.join('\n').replace(/^\s+|\s+$/g, '');
    if (level === 0 && text === '') {
      return;
    }
    sections.push({ heading, level, line: startLine, text });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      inFence = !inFence;
      buf.push(line);
      continue;
    }
    const m = inFence ? null : HEADING.exec(line);
    if (m) {
      flush();
      heading = m[2];
      level = m[1].length;
      startLine = i + 1;
      buf = [];
    } else {
      buf.push(line);
    }
  }
  flush();

  return sections;
}

const RESERVED = new Set(['task']);
const TAG_HEAD = String.raw`\p{L}[\p{L}\p{N}_-]*`;
const TAG_TAIL = String.raw`[\p{L}\p{N}_-]+`;
const INLINE_TAG = new RegExp(String.raw`(?:^|\s)#(${TAG_HEAD}(?:/${TAG_TAIL})*)`, 'gu');

/** Lower-cased, order-preserving, de-duplicated inline tags in `body`. */
export function extractInlineTags(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const scannable = body
    .replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))
    .replace(/~~~[\s\S]*?~~~/g, (m) => ' '.repeat(m.length))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
  for (const match of scannable.matchAll(INLINE_TAG)) {
    const tag = match[1].toLowerCase();
    if (RESERVED.has(tag.split('/', 1)[0])) {
      continue;
    }
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/** Exact match, or `wanted` is a parent of a nested tag (`project` ← `project/x`). */
export function tagSetMatches(tags: ReadonlySet<string>, wanted: string): boolean {
  if (tags.has(wanted)) {
    return true;
  }
  const prefix = `${wanted}/`;
  for (const t of tags) {
    if (t.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}
