import { EditorView } from '@codemirror/view';

import { applyAction, ToolbarAction } from './toolbar-commands';

/**
 * Applies one toolbar action to a CodeMirror view: reduce it to a single
 * change + selection (pure, `toolbar-commands.ts`), dispatch, and hand
 * focus back to the editor so typing continues where the action left the
 * caret. The one dispatch path behind the docked formatting bar (through
 * `MarkdownSurface`) and the strip in the editor context menu, which acts
 * on whichever view was right-clicked.
 */
export function dispatchToolbarAction(view: EditorView, action: ToolbarAction): void {
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
}

/** The text of the line the main selection's head sits on. */
export function caretLineText(view: EditorView): string {
  return view.state.doc.lineAt(view.state.selection.main.head).text;
}
