/**
 * The ticket screen's safe Markdown reader (E5c): one pure function
 * turning ticket text into structured blocks the template renders with
 * Angular's interpolation — never innerHTML, so ticket text (untrusted,
 * written by humans and agents alike) can never inject markup. The output
 * model is data: headings, paragraphs, bullet lists and code fences.
 *
 * Tolerant of anything: CRLF line endings, unclosed code fences, stray
 * HTML, tables — whatever the walk cannot classify lands in a plain
 * paragraph and the template escapes it character by character.
 */

/** One list item: a plain bullet, or a `- [x]` / `- [ ]` checkbox line. */
export interface MdListItem {
  readonly text: string;
  /** null = a plain bullet; a checkbox line's state. */
  readonly checked: boolean | null;
}

/** One rendered block. `list` groups its consecutive items. */
export type MdBlock =
  | { readonly kind: 'heading'; readonly level: number; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'list'; readonly items: readonly MdListItem[] }
  | { readonly kind: 'code'; readonly text: string };

const HEADING = /^\s{0,3}(#{1,6})[ \t]+(.*?)[ \t]*$/;
const FENCE = /^\s{0,3}```/;
const ITEM = /^\s*[-*+][ \t]+(.*)$/;
const CHECKBOX = /^\[([ xX])\](?:[ \t]+(.*))?$/;

/**
 * The text as blocks, in document order. Headings keep their level and
 * trimmed text; a fence that never closes still yields its collected
 * lines as one code block; list items adjacent in the source merge into
 * one list, a blank line or any other line ends it.
 */
export function renderMarkdown(text: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];
  let items: MdListItem[] = [];
  let code: string[] | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (items.length > 0) {
      blocks.push({ kind: 'list', items });
      items = [];
    }
  };
  const flush = (): void => {
    flushParagraph();
    flushList();
  };

  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (code !== null) {
      if (FENCE.test(raw)) {
        blocks.push({ kind: 'code', text: code.join('\n') });
        code = null;
      } else {
        code.push(raw);
      }
      continue;
    }
    if (FENCE.test(raw)) {
      flush();
      code = [];
      continue;
    }
    const heading = HEADING.exec(raw);
    if (heading !== null) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]!.replace(/[ \t#]+$/, '') });
      continue;
    }
    const item = ITEM.exec(raw);
    if (item !== null) {
      flushParagraph();
      const body = item[1] ?? '';
      const checkbox = CHECKBOX.exec(body);
      items.push(
        checkbox !== null
          ? { text: checkbox[2] ?? '', checked: checkbox[1]!.toLowerCase() === 'x' }
          : { text: body, checked: null },
      );
      continue;
    }
    if (raw.trim() === '') {
      flush();
      continue;
    }
    flushList();
    paragraph.push(raw.trim());
  }
  flush();
  if (code !== null) {
    blocks.push({ kind: 'code', text: code.join('\n') });
  }
  return blocks;
}
