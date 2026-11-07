import { withoutEmptyHeadings } from './phone-face';

/** One line of a section: a bullet, or a criterion with its checkbox (`checked` is null for a bullet). */
export interface ShapeItem {
  readonly text: string;
  readonly checked: boolean | null;
}

/** One chapter the Shaping face draws as rows (board 5b): Goal, Decisions, Constraints, Open questions, Acceptance criteria. */
export interface ShapeSection {
  /** The heading as the ticket writes it. */
  readonly title: string;
  readonly paragraphs: readonly string[];
  readonly items: readonly ShapeItem[];
}

export interface ShapeFace {
  readonly sections: readonly ShapeSection[];
  /** Everything the rows do not draw, as Markdown (an empty heading is already gone). */
  readonly rest: string;
}

const KNOWN: ReadonlySet<string> = new Set(['goal', 'decisions', 'constraints', 'open questions', 'acceptance criteria']);

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM = /^\s*[-*+]\s+(?:\[( |x|X)\]\s+)?(.*)$/;

/** Splits a ticket body into the known chapters (as rows) and the rest (as Markdown). */
export function shapeFaceOf(body: string): ShapeFace {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const sections: ShapeSection[] = [];
  const rest: string[] = [];
  let title: string | null = null;
  let paragraphs: string[] = [];
  let items: { text: string; checked: boolean | null }[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      paragraphs.push(paragraph.join(' '));
      paragraph = [];
    }
  };
  const flushSection = (): void => {
    flushParagraph();
    if (title !== null) {
      sections.push({ title, paragraphs, items });
    }
    title = null;
    paragraphs = [];
    items = [];
  };

  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (heading !== null) {
      flushSection();
      const name = heading[2]!.trim();
      if (KNOWN.has(name.toLowerCase())) {
        title = name;
      } else {
        rest.push(line);
      }
      continue;
    }
    if (title === null) {
      rest.push(line);
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
      continue;
    }
    const item = ITEM.exec(line);
    if (item !== null) {
      flushParagraph();
      items.push({ text: item[2]!.trim(), checked: item[1] === undefined ? null : item[1] !== ' ' });
      continue;
    }
    if (/^\s+\S/.test(line) && items.length > 0 && paragraph.length === 0) {
      const last = items[items.length - 1]!;
      last.text = `${last.text} ${line.trim()}`;
      continue;
    }
    paragraph.push(line.trim());
  }
  flushSection();
  return { sections, rest: withoutEmptyHeadings(rest.join('\n').trim()) };
}

/** Who edited a line since the model's last turn: the plan's marks, matched on the line's text. */
export function editorOf(text: string, marks: readonly { readonly text: string; readonly by: 'you' | 'model' }[]): 'you' | 'model' | null {
  const own = text.trim().toLowerCase();
  if (own === '') {
    return null;
  }
  const hit = marks.find((mark) => {
    const other = mark.text.trim().toLowerCase();
    return other !== '' && (other === own || own.includes(other) || other.includes(own));
  });
  return hit?.by ?? null;
}

/** The ticket's form from its frontmatter (`form: ship | scout`); an absent or unknown value reads as ship. */
export function formOf(ticketText: string): 'ship' | 'scout' {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(ticketText);
  const form = match === null ? null : /^form:\s*['"]?(\w+)/m.exec(match[1]!)?.[1]?.toLowerCase();
  return form === 'scout' ? 'scout' : 'ship';
}
