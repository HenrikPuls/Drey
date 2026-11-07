import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Prec, RangeSetBuilder, type Extension } from '@codemirror/state';
import { Decoration, MatchDecorator, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

const TAG = /(?:^|(?<=\s))#[\p{L}\p{N}][\p{L}\p{N}/_-]*/gu;

const tagMatcher = new MatchDecorator({
  regexp: TAG,
  decoration: Decoration.mark({ class: 'mdx-tag' }),
});

const tagPills = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = tagMatcher.createDeco(view);
    }
    update(update: ViewUpdate): void {
      this.decorations = tagMatcher.updateDeco(update, this.decorations);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** Marks a heading's line: the boards set its line box and the space above it. */
function headingDeco(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    let at = from;
    while (at <= to) {
      const line = view.state.doc.lineAt(at);
      if (/^#{2,3} /.test(line.text)) {
        builder.add(line.from, line.from, Decoration.line({ class: 'mdx-h2' }));
      } else if (/^# /.test(line.text)) {
        builder.add(line.from, line.from, Decoration.line({ class: 'mdx-h1' }));
      }
      at = line.to + 1;
    }
  }
  return builder.finish();
}

const headingSpace = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = headingDeco(view);
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = headingDeco(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/**
 * What the surface adds on the phone (boards 10d, 10l, 10p): the boards'
 * heading sizes over the 17 px body (26/32 and 20/28), and `#tag` drawn as a
 * pill. Shared engine and wide layouts are untouched; the shell appends this
 * to the phone's view only.
 */
export function phoneSurfaceExtension(): Extension {
  return [
    Prec.highest(
      syntaxHighlighting(
        HighlightStyle.define([
          { tag: t.heading1, fontSize: '1.53em', lineHeight: '32px' },
          { tag: t.heading2, fontSize: '1.176em', lineHeight: '28px' },
          { tag: t.heading3, fontSize: '1.176em', lineHeight: '28px' },
        ]),
      ),
    ),
    tagPills,
    headingSpace,
  ];
}
