import { EditorState, Extension, Range, StateEffect, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { frontmatterEnd, frontmatterFieldCount } from './markdown-frontmatter';

/**
 * Folds the leading YAML frontmatter behind a clickable pill
 * (`Frontmatter · 3 fields`) so a note opens as prose, not metadata. Its own
 * extension, mounted *outside* the Live Preview compartment
 * (`MarkdownSurface`), so it works the same in source mode -- which otherwise
 * loads no decorations at all.
 *
 * State is one `StateField<boolean>` per `EditorView` (`expandedField`),
 * flipped by the `setFrontmatterExpanded` effect from the pill / collapse
 * chevron. `MarkdownSurface` mirrors it into a read-only signal and replays a
 * remembered value on tab switch; CodeMirror stays the source of truth.
 *
 * Collapsed: one `Decoration.replace({ block: true })` over the frontmatter
 * lines -> the pill widget. Expanded: a dim line class per YAML line (so it
 * reads as metadata in both modes) plus a chevron widget on the `---` line to
 * fold it back. In Live Preview `conceal.ts` still adds its own
 * `.lp-frontmatter` dimming and its "never conceal inside the header" guard
 * is unchanged -- when collapsed those line decorations simply fall under the
 * block widget and never render.
 */

/** Set the open editor's frontmatter fold state (`true` = expanded/editable). */
export const setFrontmatterExpanded = StateEffect.define<boolean>();

const expandedField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setFrontmatterExpanded)) {
        value = effect.value;
      }
    }
    return value;
  },
});

/** Whether the frontmatter is currently expanded; `false` if the fold extension isn't loaded. */
export function frontmatterExpandedOf(state: EditorState): boolean {
  return state.field(expandedField, false) ?? false;
}

const dimLine = Decoration.line({ class: 'cm-fm-line' });

/**
 * Pure decoration builder (exported for tests): the block pill when
 * collapsed, dim lines + a collapse chevron when expanded, nothing when the
 * document has no frontmatter.
 */
export function foldDecorations(state: EditorState, expanded: boolean): DecorationSet {
  const text = state.sliceDoc();
  const fmEnd = frontmatterEnd(text);
  if (fmEnd === 0) {
    return Decoration.none;
  }

  const doc = state.doc;
  // `frontmatterEnd` points past the block's trailing newline; step back onto
  // the closing `---` line so the range ends at a real line boundary.
  const lastLine = doc.lineAt(text[fmEnd - 1] === '\n' ? fmEnd - 1 : fmEnd);
  const firstLine = doc.lineAt(0);

  if (!expanded) {
    return Decoration.set(
      Decoration.replace({
        widget: new FrontmatterPillWidget(frontmatterFieldCount(text)),
        block: true,
      }).range(firstLine.from, lastLine.to),
    );
  }

  const deco: Range<Decoration>[] = [];
  for (let n = firstLine.number; n <= lastLine.number; n++) {
    deco.push(dimLine.range(doc.line(n).from));
  }
  deco.push(
    Decoration.widget({ widget: new FrontmatterCollapseWidget(), side: 1 }).range(firstLine.to),
  );
  return Decoration.set(deco, true);
}

const decorationsField = StateField.define<DecorationSet>({
  create: (state) => foldDecorations(state, false),
  update(value, tr) {
    const expanded = tr.state.field(expandedField);
    if (tr.docChanged || expanded !== tr.startState.field(expandedField)) {
      return foldDecorations(tr.state, expanded);
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const CHEVRON_RIGHT =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="m9 18 6-6-6-6"/></svg>';
const CHEVRON_DOWN =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="m6 9 6 6 6-6"/></svg>';

/** The collapsed pill: `▸ Frontmatter · N fields`. Click expands (conceal plugin style: event falls through). */
class FrontmatterPillWidget extends WidgetType {
  constructor(readonly count: number) {
    super();
  }

  override eq(other: FrontmatterPillWidget): boolean {
    return other.count === this.count;
  }

  toDOM(): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-fm-pill';
    btn.title = 'Edit frontmatter';
    const fields = this.count === 1 ? '1 field' : `${this.count} fields`;
    btn.innerHTML =
      `${CHEVRON_RIGHT}<span>Frontmatter</span><span class="cm-fm-sep">·</span>` +
      `<span class="cm-fm-count">${fields}</span>`;
    return btn;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** The `⌄` on the opening `---` line while expanded; click folds the block back. */
class FrontmatterCollapseWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-fm-collapse';
    btn.title = 'Hide frontmatter';
    btn.innerHTML = CHEVRON_DOWN;
    return btn;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Pill / chevron clicks flip the fold state. `mousedown` (not `click`) to
 * match the checkbox widget in `conceal.ts` and to beat CodeMirror's own
 * selection handling. Expanding drops the caret onto the first YAML line so
 * the user can start editing straight away.
 */
const foldClicks = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target as HTMLElement | null;
    if (target?.closest('.cm-fm-pill')) {
      event.preventDefault();
      const anchor = view.state.doc.lines >= 2 ? view.state.doc.line(2).from : 0;
      view.dispatch({ effects: setFrontmatterExpanded.of(true), selection: { anchor } });
      view.focus();
      return true;
    }
    if (target?.closest('.cm-fm-collapse')) {
      event.preventDefault();
      view.dispatch({ effects: setFrontmatterExpanded.of(false) });
      return true;
    }
    return false;
  },
});

/**
 * Fold styling. A standalone theme (not `live-preview/theme.ts`) because the
 * fold is active in source mode too, where the Live Preview theme is unloaded.
 */
const foldTheme = EditorView.theme(
  {
    '.cm-fm-pill': {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      margin: '2px 0 12px',
      padding: '3px 10px 3px 6px',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-sm)',
      background: 'var(--bg-bar)',
      color: 'var(--text-5)',
      font: 'inherit',
      fontSize: '0.82em',
      lineHeight: '1.4',
      cursor: 'pointer',
    },
    '.cm-fm-pill:hover': {
      background: 'var(--hover-bg)',
      color: 'var(--text-3)',
    },
    '.cm-fm-sep': { color: 'var(--text-faint)' },
    '.cm-fm-count': { color: 'var(--text-6)' },
    '.cm-fm-line': {
      color: 'var(--text-faint)',
      fontFamily: 'var(--font-mono)',
      fontSize: '0.85em',
    },
    '.cm-fm-collapse': {
      display: 'inline-flex',
      alignItems: 'center',
      marginLeft: '8px',
      padding: '0',
      border: '0',
      background: 'transparent',
      color: 'var(--text-6)',
      cursor: 'pointer',
      verticalAlign: 'middle',
    },
    '.cm-fm-collapse:hover': { color: 'var(--text-3)' },
  },
  { dark: true },
);

export function frontmatterFold(): Extension {
  return [expandedField, decorationsField, foldClicks, foldTheme];
}
