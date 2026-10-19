import { EditorState, Extension, Range, StateEffect, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { frontmatterEnd } from './markdown-frontmatter';

/**
 * Folds the leading YAML frontmatter behind a clickable pill (`▸ Frontmatter`)
 * so a note opens as prose, not metadata. Its own extension, mounted *outside*
 * the Live Preview compartment (`MarkdownSurface`), so it works the same in
 * source mode -- which otherwise loads no decorations at all.
 *
 * State is one `StateField<boolean>` per `EditorView` (`expandedField`),
 * flipped by the `setFrontmatterExpanded` effect from the pill / expanded
 * header. `MarkdownSurface` mirrors it into a read-only signal and replays a
 * remembered value on tab switch; CodeMirror stays the source of truth.
 *
 * Collapsed: one `Decoration.replace({ block: true })` over the whole block
 * -> the `▸ Frontmatter` pill. Expanded: both `---` fences are hidden by
 * `block` `Decoration.replace`s -- the opening one carries a `⌄ Frontmatter`
 * header widget (same look as the pill, chevron flipped) to fold it back --
 * and each YAML line in between gets a dim line class. Every decoration in the
 * field also feeds `EditorView.atomicRanges` (see `decorationsField.provide`),
 * so the caret steps over the hidden fences cleanly. In Live Preview
 * `conceal.ts` still adds its own `.lp-frontmatter` dimming; when collapsed
 * those line decorations simply fall under the block widget and never render.
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
 * Pure decoration builder (exported for tests): the block pill when collapsed;
 * a `⌄ Frontmatter` header + dim YAML lines + hidden `---` fences when
 * expanded; nothing when the document has no frontmatter.
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
        widget: new FrontmatterPillWidget(),
        block: true,
      }).range(firstLine.from, lastLine.to),
    );
  }

  const deco: Range<Decoration>[] = [];
  // Opening `---` -> the `⌄ Frontmatter` header.
  deco.push(
    Decoration.replace({ widget: new FrontmatterCollapseWidget(), block: true }).range(
      firstLine.from,
      firstLine.to,
    ),
  );
  // The YAML lines in between: dim grey, still editable.
  for (let n = firstLine.number + 1; n <= lastLine.number - 1; n++) {
    deco.push(dimLine.range(doc.line(n).from));
  }
  // Closing `---`: hidden, together with the newline that precedes it so no
  // blank line is left. `block: true` -> the whole line is removed from layout.
  if (lastLine.number > firstLine.number) {
    deco.push(
      Decoration.replace({ block: true }).range(doc.line(lastLine.number - 1).to, lastLine.to),
    );
  }
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
  provide: (field) => [
    EditorView.decorations.from(field),
    // Treat the collapsed block widget as one atom, so ArrowUp / ArrowDown
    // step over the folded frontmatter cleanly instead of dropping the
    // selection to offset 0 (a block `Decoration.replace` at the document
    // start otherwise corrupts vertical cursor motion).
    EditorView.atomicRanges.of((view) => view.state.field(field, false) ?? Decoration.none),
  ],
});

const CHEVRON_RIGHT =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="m9 18 6-6-6-6"/></svg>';
const CHEVRON_DOWN =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="m6 9 6 6 6-6"/></svg>';

/** The collapsed pill: `▸ Frontmatter`. Click expands (conceal plugin style: event falls through). */
class FrontmatterPillWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-fm-pill';
    btn.title = 'Edit frontmatter';
    btn.innerHTML = `${CHEVRON_RIGHT}<span>Frontmatter</span>`;
    return btn;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/**
 * The expanded-state header replacing the opening `---`: `⌄ Frontmatter`, same
 * look as the pill with the chevron flipped. Click folds the block back.
 */
class FrontmatterCollapseWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-fm-collapse';
    btn.title = 'Hide frontmatter';
    btn.innerHTML = `${CHEVRON_DOWN}<span>Frontmatter</span>`;
    return btn;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Pill / header clicks flip the fold state. `mousedown` (not `click`) to match
 * the checkbox widget in `conceal.ts` and to beat CodeMirror's own selection
 * handling. The `.cm-fm-pill` test runs first (expand), then `.cm-fm-collapse`
 * (fold back) -- the two widgets never share a class, so the branches stay
 * exclusive. Expanding does *not* move the caret -- the YAML just appears in
 * place; the user clicks where they want to edit.
 */
const foldClicks = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target as HTMLElement | null;
    if (target?.closest('.cm-fm-pill')) {
      event.preventDefault();
      view.dispatch({ effects: setFrontmatterExpanded.of(true) });
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
    // Collapsed pill and expanded header render identically -- no box / fill,
    // just the accent chevron and a dim label where the frontmatter sits. Only
    // the chevron direction (`▸` vs `⌄`) differs.
    //
    // The vertical gap is `padding`, never `margin`: this element is the root
    // DOM node of a `block: true` `Decoration.replace` widget, and CodeMirror
    // measures block-widget height with `getBoundingClientRect()` /
    // `offsetHeight`, which excludes the element's own margin. A margin here
    // makes the height map under-count the frontmatter region, so the gutter
    // and click hit-testing for every line below it drift up by that much.
    //
    // `verticalAlign: 'top'` matters just as much: this is an `inline-flex`
    // element (so it shrink-wraps to a pill, not a full-width bar), and the
    // *default* `vertical-align: baseline` places its box using the line's
    // font-metrics baseline, which leaves a few px of "phantom" leading
    // above it that CodeMirror's height measurement doesn't know about
    // either -- the same gutter-drift symptom via a different CSS mechanism.
    // `top` pins the box to the top of its line box, no baseline math.
    '.cm-fm-pill, .cm-fm-collapse': {
      display: 'inline-flex',
      verticalAlign: 'top',
      alignItems: 'center',
      gap: '6px',
      margin: '0',
      padding: '2px 0 12px',
      border: '0',
      background: 'transparent',
      color: 'var(--text-5)',
      font: 'inherit',
      fontSize: '0.82em',
      lineHeight: '1.4',
      cursor: 'pointer',
    },
    '.cm-fm-pill:hover, .cm-fm-collapse:hover': {
      color: 'var(--text-3)',
    },
    // The chevron in the highlight colour, in both states.
    '.cm-fm-pill svg, .cm-fm-collapse svg': {
      color: 'var(--accent-fg)',
    },
    // The YAML lines while expanded: plain grey body text -- no mono face, no
    // dimming. Only the `⌄ Frontmatter` header keeps its own styling.
    '.cm-fm-line': {
      color: 'var(--text-3)',
    },
    // No frontmatter parser is wired in, so Lezer-Markdown reads the block as
    // a Setext H2 -- every line otherwise inherits heading weight/size and any
    // inline-token colours (link, string, number). This descendant selector
    // is (0,0,1,1), which outranks HighlightStyle's single-class token rules
    // without needing `!important`.
    '.cm-fm-line span': {
      color: 'var(--text-3)',
      fontWeight: '400',
      fontStyle: 'normal',
      fontSize: '1em',
      fontFamily: 'var(--font-sans)',
      textDecoration: 'none',
    },
  },
  { dark: true },
);

export function frontmatterFold(): Extension {
  return [expandedField, decorationsField, foldClicks, foldTheme];
}
