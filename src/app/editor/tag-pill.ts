import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { EditorState, Extension, Range } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { extractTagOccurrences } from '../../../shared/tags';
import { frontmatterEnd } from './markdown-frontmatter';

/**
 * Renders inline `#tag`s as small pills in the editor (both Live Preview
 * and source mode) and makes a `Ctrl`/`Cmd`-click on one run a tag search.
 *
 * The matching rule is delegated to `shared/tags` `extractTagOccurrences`,
 * so a pill appears for exactly the tags the indexer indexes -- `#task`
 * and code spans are excluded there. A per-occurrence syntax-tree check
 * drops any that still land inside code (a fenced block taller than the
 * viewport can slip past the shared helper's regex blanking).
 *
 * The pure `tagPillDecorations` is split out for unit testing, exactly as
 * `conceal.ts` does with `concealDecorations`.
 */

const pillCache = new Map<string, Decoration>();
function pill(tag: string): Decoration {
  let deco = pillCache.get(tag);
  if (!deco) {
    deco = Decoration.mark({ class: 'cm-tag-pill', attributes: { 'data-tag': tag } });
    pillCache.set(tag, deco);
  }
  return deco;
}

function insideCode(state: EditorState, pos: number): boolean {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
  for (; node; node = node.parent) {
    if (/Code|Comment/.test(node.name)) {
      return true;
    }
  }
  return false;
}

export function tagPillDecorations(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): DecorationSet {
  const deco: Range<Decoration>[] = [];
  const fmEnd = frontmatterEnd(state.sliceDoc());
  const doc = state.doc;

  for (const range of ranges) {
    // Widen to whole lines: the shared regex keys off start-of-line /
    // whitespace before the `#`, which a mid-line slice boundary would hide.
    const from = doc.lineAt(range.from).from;
    const to = doc.lineAt(range.to).to;
    const text = state.sliceDoc(from, to);

    for (const occ of extractTagOccurrences(text)) {
      const start = from + occ.index;
      const end = start + 1 + occ.tag.length;
      if (start < fmEnd || end > doc.length || insideCode(state, start)) {
        continue;
      }
      deco.push(pill(occ.tag).range(start, end));
    }
  }

  return Decoration.set(deco, true);
}

/**
 * @param onActivate called with the bare tag (no `#`) when a pill is
 *   `Ctrl`/`Cmd`-clicked. A plain click is left alone so the caret can
 *   still be placed inside the tag text.
 */
export function tagPills(onActivate: (tag: string) => void): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = tagPillDecorations(view.state, view.visibleRanges);
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = tagPillDecorations(update.state, update.view.visibleRanges);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(event) {
          if (!event.ctrlKey && !event.metaKey) {
            return false;
          }
          const el = (event.target as HTMLElement | null)?.closest('.cm-tag-pill');
          const tag = el?.getAttribute('data-tag');
          if (!tag) {
            return false;
          }
          event.preventDefault();
          onActivate(tag);
          return true;
        },
      },
    },
  );

  return [plugin, pillTheme];
}

/**
 * Pill look, keyed to the app accent. Literal rgba (not `color-mix`) to
 * match `editor-theme.ts`'s existing selection colour. `cursor: pointer`
 * signals the Ctrl/Cmd-click affordance.
 */
const pillTheme = EditorView.theme({
  '.cm-tag-pill': {
    color: 'var(--accent)',
    backgroundColor: 'rgba(201, 100, 66, 0.13)',
    borderRadius: '4px',
    padding: '0 3px',
    cursor: 'pointer',
  },
  '.cm-tag-pill:hover': {
    backgroundColor: 'rgba(201, 100, 66, 0.22)',
  },
});
