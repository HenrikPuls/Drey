import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import type { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/**
 * The formatting eraser (milestone 72, ADR-0070 later change): strips
 * INLINE formatting markers while the content stays -- the opposite end
 * of the toolbar's wrap commands, for text that arrives formatted or was
 * formatted one layer too many.
 *
 * With the CARET, one invocation peels ONE layer: the outermost inline
 * wrap at the position (`**fett ==rot==**` -> bold first, the highlight
 * on the second stroke; `***x***` -> strong, then emphasis). With a
 * SELECTION, one invocation wipes every wrap the selection overlaps --
 * one stroke of the eraser across the range.
 *
 * Not a `toolbar-commands.ts` string reducer on purpose: "outermost" is
 * a syntax-tree concept. Everything here works on the Lezer tree the
 * surface's configured grammar produces, so it sees exactly what Live
 * Preview renders. Block formatting (headings, quotes, callouts, lists)
 * is out of scope -- those have their toggles; in a quote the eraser
 * still peels the bold inside it.
 */

/** The inline constructs the eraser peels, by Lezer node name. */
const ERASABLE: ReadonlySet<string> = new Set([
  'StrongEmphasis',
  'Emphasis',
  'Strikethrough',
  'Highlight',
  'Subscript',
  'Superscript',
  'InlineCode',
  'InlineMath',
  'Link',
]);

/** One span of source to delete (a marker, a link tail, ...). */
interface DeleteRange {
  from: number;
  to: number;
}

/** The eraser's edit: deletion spans plus the mapped selection. */
export interface EraseFormattingEdit {
  changes: readonly { from: number; to: number; insert: '' }[];
  anchor: number;
  head: number;
}

/**
 * The marker spans deleting which unwraps `node`'s formatting while the
 * content stays. Most constructs carry their delimiters as `*Mark`
 * children at both ends; the two that do not are special-cased: the
 * custom `InlineMath` element is flat (`$…$`, fixed one char per side)
 * and a `Link` keeps its label but drops the `[`, the `](url)` and the
 * `)` (like "remove link" in a word processor).
 */
function unwrapRanges(node: SyntaxNode): DeleteRange[] {
  if (node.name === 'InlineMath') {
    return [
      { from: node.from, to: node.from + 1 },
      { from: node.to - 1, to: node.to },
    ];
  }
  if (node.name === 'Link') {
    const marks: SyntaxNode[] = [];
    for (let c = node.firstChild; c !== null; c = c.nextSibling) {
      if (c.name === 'LinkMark') {
        marks.push(c);
      }
    }
    if (marks.length < 3) {
      return []; // autolinks / whatever else -- nothing sensible to peel
    }
    return [
      { from: marks[0].from, to: marks[0].to },
      { from: marks[1].from, to: node.to },
    ];
  }
  const first = node.firstChild;
  const last = node.lastChild;
  if (first === null || last === null || first === last) {
    return [];
  }
  if (!/Mark$/.test(first.name) || !/Mark$/.test(last.name)) {
    return [];
  }
  return [
    { from: first.from, to: first.to },
    { from: last.from, to: last.to },
  ];
}

/**
 * The erasable ancestors of `pos`, innermost first -- the last entry is
 * the outermost wrap, the one a caret stroke peels.
 */
function erasableAncestors(state: EditorState, pos: number): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); n !== null; n = n.parent) {
    if (ERASABLE.has(n.name)) {
      out.push(n);
    }
  }
  return out;
}

/**
 * Every erasable node overlapping [from, to) (nested ones included --
 * the wipe deletes all their markers in one change).
 */
function erasableOverlapping(state: EditorState, from: number, to: number): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  let start: SyntaxNode | null = syntaxTree(state).resolveInner(from, -1);
  while (start !== null && (start.from > from || start.to < to)) {
    start = start.parent;
  }
  const visit = (n: SyntaxNode): void => {
    if (n.from >= to || n.to <= from) {
      return; // children sit inside their parent -- nothing to find here
    }
    if (ERASABLE.has(n.name)) {
      out.push(n);
    }
    for (let c = n.firstChild; c !== null; c = c.nextSibling) {
      visit(c);
    }
  };
  if (start !== null) {
    visit(start);
  }
  return out;
}

/** Sorts, merges and de-dupes the collected delete spans. */
function mergeRanges(ranges: DeleteRange[]): DeleteRange[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: DeleteRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && r.from <= last.to) {
      last.to = Math.max(last.to, r.to);
    } else {
      merged.push({ from: r.from, to: r.to });
    }
  }
  return merged;
}

/** Maps a position through the deletions; a position inside a deleted
 *  marker clamps to that marker's start. */
function mapThrough(ranges: readonly DeleteRange[], pos: number): number {
  let out = pos;
  for (const r of ranges) {
    if (pos >= r.to) {
      out -= r.to - r.from;
    } else if (pos > r.from) {
      out -= pos - r.from;
    }
  }
  return out;
}

/**
 * Computes the eraser's edit for `state`'s current selection: `null`
 * when there is nothing erasable (a later no-op dispatch would only
 * pollute the undo history).
 */
export function eraseFormattingEdit(state: EditorState): EraseFormattingEdit | null {
  const { from, to } = state.selection.main;
  const nodes =
    from === to
      ? (() => {
          const ancestors = erasableAncestors(state, from);
          return ancestors.length === 0 ? [] : [ancestors[ancestors.length - 1]];
        })()
      : erasableOverlapping(state, from, to);
  if (nodes.length === 0) {
    return null;
  }
  const ranges = mergeRanges(nodes.flatMap(unwrapRanges).filter((r) => r.to > r.from));
  if (ranges.length === 0) {
    return null;
  }
  return {
    changes: ranges.map((r) => ({ from: r.from, to: r.to, insert: '' })),
    anchor: mapThrough(ranges, from),
    head: mapThrough(ranges, to),
  };
}

/** Runs the eraser on `view` (one undo step, selection on the content). */
export function eraseFormatting(view: EditorView): void {
  if (view.state.readOnly) {
    return;
  }
  const edit = eraseFormattingEdit(view.state);
  if (edit === null) {
    return;
  }
  view.dispatch({
    changes: edit.changes,
    selection: { anchor: edit.anchor, head: edit.head },
    scrollIntoView: true,
    userEvent: 'delete.clearFormatting',
  });
}
