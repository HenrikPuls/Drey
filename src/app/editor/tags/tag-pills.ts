import {
  RangeSet,
  StateEffect,
  type EditorState,
  type Extension,
  type Range,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { frontmatterEnd } from '../markdown-frontmatter';
import { insideCode } from '../markdown-context';
import { extractTagOccurrences } from '../../../../shared/tag-grammar';

/**
 * Inline `#tag` pills in the Markdown surfaces (milestone 33: a BASE editor
 * feature — moved here from the tags plugin's renderer, whose only remaining
 * job is the data). Every occurrence outside frontmatter and code gets a
 * `cm-tag-pill` mark carrying `data-tag` plus an inline `--tag-hue` (the
 * tag's resolved prefix/auto color), so Ctrl/Cmd-click runs a tag search
 * (`search.open` with `{ tag }`) and the coloring follows the Tags
 * settings page live: the surface dispatches {@link tagStyleRefresh} when
 * the vocabulary's styles revision ticks.
 */

/** Tells every pill plugin to re-resolve its tag colors (Settings changed). */
export const tagStyleRefresh = StateEffect.define<null>();

export interface TagPillsConfig {
  /** Resolved display color for one tag (prefix style or auto palette). */
  colorFor: (tag: string) => string;
  /** Ctrl/Cmd-click on a pill. */
  onActivate?: (tag: string) => void;
}

export function tagPills(config: TagPillsConfig): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = tagPillDecorationSet(config, view.state, view.visibleRanges);
      }

      update(update: ViewUpdate): void {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.transactions.some((tr) => tr.effects.some((e) => e.is(tagStyleRefresh)))
        ) {
          this.decorations = tagPillDecorationSet(config, update.state, update.view.visibleRanges);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(event: MouseEvent): boolean {
          if (!event.ctrlKey && !event.metaKey) {
            return false;
          }
          const target = event.target as HTMLElement | null;
          const tag = target?.closest('.cm-tag-pill')?.getAttribute('data-tag');
          if (!tag) {
            return false;
          }
          event.preventDefault();
          config.onActivate?.(tag);
          return true;
        },
      },
    },
  );

  const theme = EditorView.theme({
    '.cm-tag-pill': {
      color: 'var(--tag-hue, var(--accent))',
      backgroundColor: 'color-mix(in srgb, var(--tag-hue, var(--accent)) 13%, transparent)',
      borderRadius: '4px',
      padding: '0 3px',
      cursor: 'pointer',
    },
    '.cm-tag-pill:hover': {
      backgroundColor: 'color-mix(in srgb, var(--tag-hue, var(--accent)) 22%, transparent)',
    },
  });

  return [plugin, theme];
}

/**
 * The pill marks for one snapshot — exported for the test suite; the view
 * plugin just re-runs it on doc/viewport/style changes.
 */
export function tagPillDecorationSet(
  config: TagPillsConfig,
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): DecorationSet {
  const fmEnd = frontmatterEnd(state.sliceDoc());
  const deco: Range<Decoration>[] = [];
  // Cache per tag + color: the same tag re-resolving to a new color must
  // produce a fresh mark (the inline `--tag-hue` lives on the decoration).
  const pillCache = new Map<string, Decoration>();
  const pill = (tag: string): Decoration => {
    const color = config.colorFor(tag);
    const key = `${tag} ${color}`;
    let mark = pillCache.get(key);
    if (!mark) {
      mark = Decoration.mark({
        class: 'cm-tag-pill',
        attributes: { 'data-tag': tag, style: `--tag-hue:${color}` },
      });
      pillCache.set(key, mark);
    }
    return mark;
  };

  for (const range of ranges) {
    // Widen to whole lines: the shared regex keys off start-of-line /
    // whitespace before the `#`, which a mid-line slice boundary would hide.
    const from = state.doc.lineAt(range.from).from;
    const to = state.doc.lineAt(range.to).to;
    const text = state.sliceDoc(from, to);

    for (const occ of extractTagOccurrences(text)) {
      const start = from + occ.index;
      const end = start + 1 + occ.tag.length;
      if (start < fmEnd || end > state.doc.length || insideCode(state, start)) {
        continue;
      }
      deco.push(pill(occ.tag).range(start, end));
    }
  }
  return RangeSet.of(deco, true);
}
