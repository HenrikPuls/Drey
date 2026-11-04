import { indentLess, insertTab } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { Extension, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

/**
 * Tab / Shift-Tab inside the editor: a literal tab character at the caret,
 * or line indentation when a selection spans text. Without this, Tab is
 * unbound in `basicSetup` (it deliberately ships no `indentWithTab`), so the
 * browser's default focus navigation ran and the caret left the editor.
 *
 * `insertTab` already encodes the split we want -- empty cursors insert
 * `\t`, a non-empty range falls through to `indentMore` (indents each
 * selected *line*, keeping the text) -- and `indentMore` / `indentLess`
 * derive their step from the `indentUnit` facet, which is set to a literal
 * tab to match. Shift+Tab always outdents.
 *
 * Bound `Prec.highest` so the binding also wins over any keymap a runtime
 * plugin contributes (ADR-0044), and gated on `view.editable` so the
 * read-only assistant composer still lets Tab fall through untouched.
 *
 * The a11y tradeoff is deliberate (project owner's call, roadmap bug-9):
 * Tab no longer moves keyboard focus out of the editor -- `F6` /
 * `Shift+F6` (pane focus commands) remain the way out.
 */
export const editorIndentation: Extension = [
  indentUnit.of('\t'),
  Prec.highest(
    keymap.of([
      {
        key: 'Tab',
        run: (view) =>
          view.state.facet(EditorView.editable) ? insertTab(view) : false,
        shift: (view) =>
          view.state.facet(EditorView.editable) ? indentLess(view) : false,
      },
    ]),
  ),
];
