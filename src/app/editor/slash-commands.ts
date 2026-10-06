import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { inCompletableText, markdownContextAt } from './markdown-context';
import { applyAction, ToolbarAction } from './toolbar-commands';

/**
 * The `/` selection dialog: typing a `/` at a line start or after whitespace
 * opens CodeMirror's completion popup with the formatting toolbar's block
 * commands (plus the two keyboard-only extras, code block and divider).
 * Picking an entry removes the typed slash and applies the same pure
 * reducer the toolbar uses (`toolbar-commands.ts`) -- one code path, two
 * entries.
 *
 * Silent inside code, frontmatter, links and raw HTML (the shared
 * Markdown-context gate) and after a non-space character, so URLs, paths,
 * `and/or` and dates never trigger it.
 */
interface SlashCommand {
  label: string;
  action: ToolbarAction;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { label: 'Heading 1', action: { kind: 'heading', level: 1 } },
  { label: 'Heading 2', action: { kind: 'heading', level: 2 } },
  { label: 'Heading 3', action: { kind: 'heading', level: 3 } },
  { label: 'Bullet list', action: { kind: 'list', style: 'bullet' } },
  { label: 'Numbered list', action: { kind: 'list', style: 'ordered' } },
  { label: 'Task list', action: { kind: 'list', style: 'task' } },
  { label: 'Blockquote', action: { kind: 'quote' } },
  { label: 'Code block', action: { kind: 'fence' } },
  { label: 'Table', action: { kind: 'table', rows: 3, cols: 2 } },
  { label: 'Divider', action: { kind: 'divider' } },
  { label: 'Link', action: { kind: 'link' } },
];

/**
 * Applies a picked command: cut the typed `/query` out first, run the
 * reducer on the resulting text with the caret where the slash was, then
 * land the whole thing as ONE document replace (one undo step).
 */
function applySlash(
  view: EditorView,
  action: ToolbarAction,
  from: number,
  to: number,
): void {
  const original = view.state.doc.toString();
  const without = original.slice(0, from) + original.slice(to);
  const caret = Math.min(from, without.length);
  const edit = applyAction(without, caret, caret, action);
  const next = without.slice(0, edit.from) + edit.insert + without.slice(edit.to);
  view.dispatch({
    changes: { from: 0, to: original.length, insert: next },
    selection: EditorSelection.range(edit.selFrom, edit.selTo),
    userEvent: 'input.slashCommand',
  });
}

/**
 * The completion source. Mounted on the Markdown language like the tag /
 * wikilink sources; not on the Enter-submits composers (a popup that
 * swallows Enter must not eat the chat composer's submit).
 */
export function slashCommandSource(context: CompletionContext): CompletionResult | null {
  const token = context.matchBefore(/\/[\w-]*/);
  if (!token) {
    return null;
  }
  // Only at a line start or after whitespace -- `https://`, `and/or`,
  // `2026/10` and paths must not open the dialog.
  if (token.from > 0 && !/\s/.test(context.state.sliceDoc(token.from - 1, token.from))) {
    return null;
  }
  if (!inCompletableText(markdownContextAt(context.state, context.pos))) {
    return null;
  }

  const query = token.text.slice(1).toLowerCase();
  const matches = SLASH_COMMANDS.filter((cmd) => cmd.label.toLowerCase().startsWith(query));
  if (matches.length === 0) {
    return null;
  }
  const options: Completion[] = matches.map((cmd) => ({
    label: cmd.label,
    type: 'keyword',
    apply: (view, _completion, from, to) => applySlash(view, cmd.action, from, to),
  }));
  return { from: token.from, options, validFor: /^\/[\w-]*$/u };
}
