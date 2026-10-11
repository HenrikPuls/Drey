import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import type { EditorState, Line } from '@codemirror/state';
import { frontmatterEnd } from './markdown-frontmatter';
import { TAG_NAME_SOURCE } from '../../../shared/tag-grammar';

/**
 * One shared answer to "what is the caret sitting in?" for the Markdown
 * surface's completion sources (`#tag`, `[[wikilink]]`, word completion).
 * Everything structural comes from the Lezer tree (GFM tables included);
 * three constructs the parser has no node for are checked textually:
 * frontmatter (leading `---` fence, as everywhere else in the editor),
 * an unclosed `[[...` and a trailing `#tag` token -- plus a line-shape
 * fallback for a table row typed before the parser can build a `Table`
 * (the delimiter row is what turns the block into a node, so the header
 * line above a not-yet-complete table is plain text to the tree).
 *
 * The pure parts are unit-tested; the completion sources only branch on
 * `kind`, so they stay free of tree-walking of their own.
 */

export type MarkdownContext =
  | { kind: 'code-block' }
  | { kind: 'code-span' }
  | { kind: 'frontmatter' }
  | { kind: 'link' }
  | { kind: 'html' }
  | { kind: 'tag' }
  | { kind: 'wikilink' }
  | { kind: 'table' }
  | { kind: 'heading' }
  | { kind: 'math' }
  | { kind: 'prose' };

/** Contexts where none of the completion sources may fire. Tables,
 * headings and prose are all fair game (a `#tag` or a word belongs there
 * just as much as plain text does). */
const NON_TEXT_KINDS: ReadonlySet<string> = new Set([
  'code-block',
  'code-span',
  'frontmatter',
  'link',
  'html',
  'math',
]);

/** True when the completion sources may speak at `context`. */
export function inCompletableText(context: MarkdownContext): boolean {
  return !NON_TEXT_KINDS.has(context.kind);
}

/** Node-name classes per context kind; everything unmapped is plain text. */
function treeKind(name: string): MarkdownContext | null {
  switch (name) {
    case 'InlineCode':
      return { kind: 'code-span' };
    case 'FencedCode':
    case 'CodeText':
    case 'CodeMark':
    case 'CodeInfo':
      return { kind: 'code-block' };
    case 'Link':
    case 'Image':
    case 'URL':
    case 'Autolink':
    case 'FootnoteRef':
      return { kind: 'link' };
    case 'InlineMath':
    case 'MathBlock':
      return { kind: 'math' };
    case 'HTMLBlock':
    case 'HTMLTag':
    case 'Comment':
    case 'ProcessingInstruction':
      return { kind: 'html' };
    case 'Table':
    case 'TableHeader':
    case 'TableRow':
    case 'TableCell':
    case 'TableDelimiter':
      return { kind: 'table' };
    default:
      return /^(?:ATX|Setext)Heading\d$/.test(name) ? { kind: 'heading' } : null;
  }
}

/** An unclosed `[[` before the cursor (no parser node exists for wikilinks). */
const OPEN_WIKILINK = /\[\[[^[\]\n]*$/u;

/** A `#tag` token ending at the cursor -- same rule as the shared tag
 * grammar's `INLINE_TAG`: preceded by line start or whitespace. */
const TAG_AT_END = new RegExp(`(?:^|\\s)#(?:${TAG_NAME_SOURCE})$`, 'u');

/** A line that looks like a table row (leading pipe) or a delimiter row. */
const TABLE_ROW = /^[ \t]*\|/;
const TABLE_DELIM = /^[ \t]*\|?[ :|-]*-[ :|-]*\|?[ \t]*$/;

/** True when `line` is row/delimiter-shaped AND a delimiter row sits
 * within two lines of it -- the "table being typed" fallback for the
 * lines the parser does not cover with a `Table` node yet. */
function nearTableDelimiter(state: EditorState, line: Line): boolean {
  if (!TABLE_ROW.test(line.text) && !TABLE_DELIM.test(line.text)) {
    return false;
  }
  const first = Math.max(1, line.number - 2);
  const last = Math.min(state.doc.lines, line.number + 2);
  for (let n = first; n <= last; n++) {
    if (n !== line.number && TABLE_DELIM.test(state.doc.line(n).text)) {
      return true;
    }
  }
  return false;
}

/**
 * The Markdown context at `pos`. Tree nodes win (they are authoritative
 * for everything the parser recognises), then the textual checks for the
 * constructs without nodes, then the table fallback, then prose.
 */
export function markdownContextAt(state: EditorState, pos: number): MarkdownContext {
  // Frontmatter is not in the Lezer tree; only docs that actually open
  // with a `---` fence pay for the textual scan.
  if (state.sliceDoc(0, 4) === '---\n' && pos < frontmatterEnd(state.sliceDoc())) {
    return { kind: 'frontmatter' };
  }

  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node !== null; node = node.parent) {
    const mapped = treeKind(node.name);
    if (mapped !== null) {
      return mapped;
    }
  }

  const line = state.doc.lineAt(pos);
  const before = state.sliceDoc(line.from, pos);
  if (OPEN_WIKILINK.test(before)) {
    return { kind: 'wikilink' };
  }
  if (TAG_AT_END.test(before)) {
    return { kind: 'tag' };
  }
  if (nearTableDelimiter(state, line)) {
    return { kind: 'table' };
  }
  return { kind: 'prose' };
}

/**
 * True when `pos` sits inside code (span or block, fenced-code info line
 * included) or an HTML comment -- the pills'/decorations' guard, shared
 * here so `tag-pills.ts` and `wikilink.ts` stop carrying identical copies.
 * This is the decoration-side twin of the detector: broader bias (+1) and
 * the comment check the completion gate expresses as kind `html`.
 */
export function insideCode(state: EditorState, pos: number): boolean {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
  for (; node !== null; node = node.parent) {
    if (/Code|Comment/.test(node.name)) {
      return true;
    }
  }
  return false;
}
