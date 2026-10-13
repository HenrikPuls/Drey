import { EditorView } from '@codemirror/view';
import type { EditorContextMenuTarget } from '../../../shared/plugin-api/renderer';

/**
 * Whether the editor context menu carries the formatting strip (req-41),
 * and for which view: the CodeMirror view behind the right-click when it
 * is an editable Markdown surface, `null` otherwise.
 *
 * The strip shows on every Markdown CodeMirror surface: pane documents
 * (gated on `isMarkdown`, so a `.ts` tab stays clean), the entry drawer
 * and the plugin composers (both carry no `docPath` and are always
 * Markdown). A read-only view (View mode, a help document) gets none --
 * there is nothing to format.
 */
export function formattingStripView(
  target: EditorContextMenuTarget | null,
  deps: { isMarkdown(docPath: string): boolean },
): EditorView | null {
  if (target === null || target.surface !== 'editor') {
    return null;
  }
  if (target.docPath !== null && !deps.isMarkdown(target.docPath)) {
    return null;
  }
  const host = target.target.closest('.cm-editor');
  const view = host === null ? null : EditorView.findFromDOM(host as HTMLElement);
  return view === null || view.state.readOnly ? null : view;
}
