/**
 * Splits a Markdown body into heading-delimited sections. A section runs
 * from one heading line to the next heading of *any* level; content before
 * the first heading (or a file with none) is one implicit section with an
 * empty heading. Fenced code blocks are skipped so a `#` inside a fence is
 * not mistaken for a heading.
 *
 * This is the unit the tag search reports on: `#sailing` AND `#kauf` means
 * both tags appear in the same `Section`.
 */

export interface Section {
  /** Heading text without the leading `#`s, or `''` for the pre-heading part. */
  heading: string;
  /** 1–6 for a real heading, 0 for the implicit pre-heading section. */
  level: number;
  /** 1-based line the section starts on (the heading line, or line 1). */
  line: number;
  /** The section's text, heading line excluded, outer blank lines trimmed. */
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
    // Drop an empty pre-heading section; keep every real heading section
    // even when its body is blank.
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
