import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { EditorState, Range } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { frontmatterEnd } from '../markdown-frontmatter';
import { extractWikilinks } from '../wikilinks/wikilink';
import { fenceLang } from './fenced-code';
import { BulletWidget, CheckboxWidget, HrWidget } from './widgets';

/**
 * The concealing half of Live Preview (ADR-0009): syntax markers (`#`, `**`,
 * `` ` ``, `>`, fences, link URLs, ...) are replaced by zero-width decorations
 * -- or small widgets (bullets, checkboxes, rules) -- everywhere except where
 * the selection is. The document text itself is never touched, which is what
 * keeps the cursor navigable (requirement: arrow keys walk through rendered
 * spans): the moment the selection touches a construct's reveal scope, its
 * decorations are dropped and the raw Markdown is back.
 *
 * Reveal scopes: inline formatting reveals when the selection touches the
 * *node* (so clicking into a bold word shows its `**`); line-oriented markers
 * (headings, quotes, list bullets, rules) reveal when the selection touches
 * their *line*; a fenced-code block reveals its fences while the selection is
 * anywhere inside the block.
 *
 * Everything before `frontmatterEnd` is inert: no concealing, just a dimming
 * line class -- the YAML header is metadata, not prose.
 */

/** How long `ensureSyntaxTree` may parse before falling back to the partial tree. */
const PARSE_BUDGET_MS = 20;

/** A fence line: nothing but backticks/tildes (plus the info string on the opener). */
const CLOSING_FENCE = /^\s*(`{3,}|~{3,})\s*$/;

const quoteLine = Decoration.line({ class: 'lp-quote' });
const codeLine = Decoration.line({ class: 'lp-code' });
const codeLineFirst = Decoration.line({ class: 'lp-code lp-code-first' });
const codeLineLast = Decoration.line({ class: 'lp-code lp-code-last' });
const frontmatterLine = Decoration.line({ class: 'lp-frontmatter' });
const inlineCodeMark = Decoration.mark({ class: 'lp-inline-code' });
const taskDoneMark = Decoration.mark({ class: 'lp-task-done' });
const hidden = Decoration.replace({});

/**
 * First line of a concealed fenced block: carries the fence's info string
 * as `data-lang`, which the theme paints as a badge on the block's right
 * (`.lp-code-first[data-lang]::after`). Cached per language -- decorations
 * are compared by identity across rebuilds.
 */
const langLineCache = new Map<string, Decoration>();
function codeLineFirstWithLang(lang: string): Decoration {
  let deco = langLineCache.get(lang);
  if (!deco) {
    deco = Decoration.line({ class: 'lp-code lp-code-first', attributes: { 'data-lang': lang } });
    langLineCache.set(lang, deco);
  }
  return deco;
}

export function concealDecorations(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): DecorationSet {
  const deco: Range<Decoration>[] = [];
  const doc = state.doc;
  const fmEnd = frontmatterEnd(state.sliceDoc());

  const touches = (from: number, to: number): boolean =>
    state.selection.ranges.some((r) => r.from <= to && r.to >= from);
  const touchesLine = (pos: number): boolean => {
    const line = doc.lineAt(pos);
    return touches(line.from, line.to);
  };
  /** Extend `to` over one following space so e.g. `## ` vanishes as a unit. */
  const eatSpace = (to: number): number => (state.sliceDoc(to, to + 1) === ' ' ? to + 1 : to);
  const hide = (from: number, to: number): void => {
    if (from >= fmEnd && from < to) {
      deco.push(hidden.range(from, to));
    }
  };
  const replaceWith = (from: number, to: number, widget: Decoration): void => {
    if (from >= fmEnd) {
      deco.push(widget.range(from, to));
    }
  };

  if (fmEnd > 0) {
    for (let pos = 0; pos < fmEnd && pos <= doc.length;) {
      const line = doc.lineAt(pos);
      deco.push(frontmatterLine.range(line.from));
      pos = line.to + 1;
    }
  }

  const lastVisible = ranges.length > 0 ? ranges[ranges.length - 1].to : 0;
  const tree = ensureSyntaxTree(state, lastVisible, PARSE_BUDGET_MS) ?? syntaxTree(state);

  // `[[wikilinks]]` (req-20) are scanned by regex, before the tree walk:
  // lezer-markdown parses the text between the brackets as an ordinary
  // (shortcut-reference) `Link`, whose marks must NOT be concealed here --
  // the wikilink pass below hides the outer `[[`/`]]` instead.
  const wikiSpans: { start: number; end: number; occ: ReturnType<typeof extractWikilinks>[0] }[] =
    [];
  for (const { from, to } of ranges) {
    const lineFrom = doc.lineAt(from).from;
    const lineTo = doc.lineAt(to).to;
    for (const occ of extractWikilinks(state.sliceDoc(lineFrom, lineTo))) {
      const start = lineFrom + occ.index;
      if (start >= fmEnd) {
        wikiSpans.push({ start, end: start + occ.length, occ });
      }
    }
  }
  const inWiki = (pos: number): boolean =>
    wikiSpans.some((s) => pos >= s.start && pos < s.end);

  for (const { from, to } of ranges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        switch (node.name) {
          case 'HeaderMark': {
            // ATX `#`s (and a trailing `#` run) or a Setext underline.
            const parent = node.node.parent;
            if (parent && !touches(parent.from, parent.to)) {
              hide(node.from, parent.name.startsWith('ATXHeading') ? eatSpace(node.to) : node.to);
            }
            return;
          }
          case 'EmphasisMark':
          case 'StrikethroughMark': {
            const parent = node.node.parent;
            if (parent && !touches(parent.from, parent.to)) {
              hide(node.from, node.to);
            }
            return;
          }
          case 'InlineCode': {
            if (node.from >= fmEnd) {
              deco.push(inlineCodeMark.range(node.from, node.to));
            }
            return;
          }
          case 'CodeMark': {
            // Only inline backticks -- fence marks are handled per block below.
            const parent = node.node.parent;
            if (parent?.name === 'InlineCode' && !touches(parent.from, parent.to)) {
              hide(node.from, node.to);
            }
            return;
          }
          case 'LinkMark': {
            // `[`, `]`, `(`, `)` of a link, or the `<`/`>` of an autolink.
            const parent = node.node.parent;
            if (
              parent &&
              (parent.name === 'Link' || parent.name === 'Autolink') &&
              !touches(parent.from, parent.to) &&
              !inWiki(node.from)
            ) {
              hide(node.from, node.to);
            }
            return;
          }
          case 'URL':
          case 'LinkTitle': {
            // Hide the target, keep the label. Only inside `Link` -- an
            // autolink's URL *is* the label, and an Image is replaced whole
            // by the block-render layer.
            const parent = node.node.parent;
            if (parent?.name === 'Link' && !touches(parent.from, parent.to) && !inWiki(node.from)) {
              hide(node.from, node.to);
            }
            return;
          }
          case 'Blockquote': {
            for (let pos = Math.max(node.from, fmEnd); pos <= node.to;) {
              const line = doc.lineAt(pos);
              deco.push(quoteLine.range(line.from));
              pos = line.to + 1;
            }
            return;
          }
          case 'QuoteMark': {
            if (!touchesLine(node.from)) {
              hide(node.from, eatSpace(node.to));
            }
            return;
          }
          case 'ListMark': {
            const grand = node.node.parent?.parent;
            if (grand?.name !== 'BulletList' || touchesLine(node.from)) {
              return; // ordered-list numbers stay as they are
            }
            if (node.node.nextSibling?.name === 'Task') {
              hide(node.from, node.to); // the checkbox replaces the whole marker
            } else {
              replaceWith(node.from, node.to, Decoration.replace({ widget: new BulletWidget() }));
            }
            return;
          }
          case 'Task': {
            // Strike the text of a checked `- [x]` item -- kept even while
            // the line is being edited, since it is a readability cue, not
            // a syntax marker to reveal.
            const marker = node.node.getChild('TaskMarker');
            if (marker && /x/i.test(state.sliceDoc(marker.from, marker.to))) {
              const from = eatSpace(marker.to);
              if (node.to > from) {
                deco.push(taskDoneMark.range(from, node.to));
              }
            }
            return;
          }
          case 'TaskMarker': {
            if (touchesLine(node.from)) {
              return;
            }
            const checked = /x/i.test(state.sliceDoc(node.from, node.to));
            replaceWith(
              node.from,
              eatSpace(node.to),
              Decoration.replace({ widget: new CheckboxWidget(checked) }),
            );
            return;
          }
          case 'HorizontalRule': {
            if (!touchesLine(node.from)) {
              replaceWith(node.from, node.to, Decoration.replace({ widget: new HrWidget() }));
            }
            return;
          }
          case 'FencedCode': {
            if (node.from < fmEnd) {
              return false;
            }
            const firstLine = doc.lineAt(node.from);
            const lastLine = doc.lineAt(node.to);
            const revealed = touches(node.from, node.to);
            const info = node.node.getChild('CodeInfo');
            // A concealed ```mermaid fence is owned whole by block-render.ts
            // (the rendered diagram widget). Adding line backgrounds / hiding
            // its fence lines here would fight that block replacement.
            if (!revealed && info && fenceLang(state.sliceDoc(info.from, info.to)) === 'mermaid') {
              return false;
            }
            // The language badge shows only while the fence is concealed --
            // the raw ```lang already says it otherwise.
            const lang = !revealed && info ? state.sliceDoc(info.from, info.to).trim() : '';
            for (let pos = node.from; pos <= node.to;) {
              const line = doc.lineAt(pos);
              const cls =
                line.number === firstLine.number
                  ? lang
                    ? codeLineFirstWithLang(lang)
                    : codeLineFirst
                  : line.number === lastLine.number && CLOSING_FENCE.test(lastLine.text)
                    ? codeLineLast
                    : codeLine;
              deco.push(cls.range(line.from));
              pos = line.to + 1;
            }
            if (!revealed) {
              // The concealed fence lines stay as slim padding strips of the
              // block (they keep the `lp-code` background).
              hide(firstLine.from, firstLine.to);
              if (lastLine.number !== firstLine.number && CLOSING_FENCE.test(lastLine.text)) {
                hide(lastLine.from, lastLine.to);
              }
            }
            return false; // don't walk the embedded language's tree
          }
          default:
            return;
        }
      },
    });
  }

  // The wikilink bracket hiding itself (Live-Preview-only: the link styling
  // and Ctrl+click live in the language compartment's `wikilinks` plugin).
  // Revealed like inline formatting -- the selection touching the span
  // brings the raw syntax back. An alias hides everything left of it, so
  // only the alias text shows.
  const inCode = (pos: number): boolean => {
    let node: SyntaxNode | null = tree.resolveInner(pos, 1);
    for (; node !== null; node = node.parent) {
      if (/Code|Comment/.test(node.name)) {
        return true;
      }
    }
    return false;
  };
  for (const { start, end, occ } of wikiSpans) {
    if (touches(start, end) || inCode(start)) {
      continue;
    }
    if (occ.alias !== null) {
      hide(start, start + occ.aliasStart); // `[[`, target, `#anchor` and the `|`
    } else {
      hide(start, start + 2); // `[[`
    }
    hide(end - 2, end); // `]]`
  }

  return Decoration.set(deco, true);
}

/** Flip `[ ]` ⇄ `[x]` at `pos` (the marker start a checkbox widget replaced). */
function toggleTask(view: EditorView, pos: number): boolean {
  const match = /^\[([ xX])\]/.exec(view.state.sliceDoc(pos, pos + 3));
  if (!match) {
    return false;
  }
  view.dispatch({
    changes: { from: pos + 1, to: pos + 2, insert: match[1] === ' ' ? 'x' : ' ' },
    // Distinct from the Mod+Enter command's `input.toggleTask`: a CLICK on
    // the rendered checkbox is the same explicit "done" gesture as the
    // Tasks panel's row toggle, and the surface saves on it (the panel
    // always saved; a click that only dirtied the buffer never reached the
    // vault-scope task list).
    userEvent: 'input.toggleTask.click',
  });
  return true;
}

export const livePreviewConceal = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = concealDecorations(view.state, view.visibleRanges);
    }

    update(update: ViewUpdate): void {
      // The tree-identity check catches the async parser finishing after the
      // doc/selection/viewport last changed -- without it, constructs beyond
      // the initial parse budget would stay raw until the next interaction.
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      ) {
        this.decorations = concealDecorations(update.state, update.view.visibleRanges);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousedown(event, view) {
        const target = event.target as HTMLElement | null;
        const wrap = target instanceof HTMLInputElement ? target.closest('.lp-task') : null;
        return wrap ? toggleTask(view, view.posAtDOM(wrap)) : false;
      },
    },
  },
);
