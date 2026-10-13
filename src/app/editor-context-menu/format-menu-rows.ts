import { EditorView } from '@codemirror/view';
import type { ContextMenuItem, EditorContextMenuTarget } from '../../../shared/plugin-api/renderer';
import { applyAction, ToolbarAction } from '../editor/toolbar-commands';
import { eraseFormatting } from '../editor/erase-formatting';
import { EmojiPickerService } from '../emoji-picker/emoji-picker.service';

/**
 * The extended-Markdown rows in the editor's right-click menu (milestone
 * 72, ADR-0070): the same pure reducers the toolbar and the `/` menu use
 * -- one command layer, three entries -- applied to the selection of the
 * surface that was right-clicked, plus the "Emoji…" row that opens the
 * `:emoji:` picker.
 *
 * Rows appear on every Markdown CodeMirror surface: pane documents (gated
 * on `isMarkdown`, so a `.ts` tab stays clean), the entry drawer and the
 * plugin composers (both carry no `docPath` and are always Markdown).
 * The view is resolved when the menu BUILDS -- the component closes the
 * menu (and drops its target) before `run()` fires, but the DOM node and
 * the view it maps to live on.
 */
export const FORMAT_CONTEXT_ACTIONS: readonly { label: string; action: ToolbarAction }[] = [
  { label: 'Highlight', action: { kind: 'highlight' } },
  { label: 'Subscript', action: { kind: 'subscript' } },
  { label: 'Superscript', action: { kind: 'superscript' } },
  { label: 'Inline math', action: { kind: 'mathInline' } },
  { label: 'Math block', action: { kind: 'mathBlock' } },
  { label: 'Callout', action: { kind: 'callout', variant: 'note' } },
  { label: 'Footnote', action: { kind: 'footnote' } },
];

/** Builds the rows for one menu open; `[]` whenever the target is not a
 *  Markdown editor surface (or its view is already gone). */
export function formattingContextMenuRows(
  target: EditorContextMenuTarget,
  deps: { isMarkdown(docPath: string): boolean; emoji: EmojiPickerService },
): readonly ContextMenuItem[] {
  if (target.surface !== 'editor') {
    return [];
  }
  if (target.docPath !== null && !deps.isMarkdown(target.docPath)) {
    return [];
  }
  const host = target.target.closest('.cm-editor');
  const view = host === null ? null : EditorView.findFromDOM(host as HTMLElement);
  if (view === null) {
    return [];
  }

  const apply = (action: ToolbarAction) => (): void => {
    if (view.state.readOnly) {
      return;
    }
    const { from, to } = view.state.selection.main;
    const edit = applyAction(view.state.doc.toString(), from, to, action);
    view.dispatch({
      changes: { from: edit.from, to: edit.to, insert: edit.insert },
      selection: { anchor: edit.selFrom, head: edit.selTo },
      scrollIntoView: true,
    });
    view.focus();
  };

  return [
    ...FORMAT_CONTEXT_ACTIONS.map(({ label, action }) => ({ label, run: apply(action) })),
    {
      label: 'Clear formatting',
      run: (): void => {
        eraseFormatting(view);
      },
    },
    {
      label: 'Emoji…',
      run: (): void => {
        const { from, to } = view.state.selection.main;
        deps.emoji.open({ view, from, to });
      },
    },
  ];
}
