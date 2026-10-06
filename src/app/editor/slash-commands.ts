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
 * Since milestone 43 the popup is sectioned: **Templates** first -- the
 * built-in **Entry** block (the configurable entry format, ADR-0022; it
 * replaced the "Add entry" drawer) plus whatever the templates plugin
 * contributes through its own source -- then **Formatting**. The selected
 * template shows a preview card beside the list (`info`).
 *
 * Silent inside code, frontmatter, links and raw HTML (the shared
 * Markdown-context gate) and after a non-space character, so URLs, paths,
 * `and/or` and dates never trigger it.
 */
interface SlashCommand {
  label: string;
  action: ToolbarAction;
}

/**
 * Section descriptors. The templates plugin builds the same `Templates`
 * section by name (it cannot import this file -- plugin renderers load
 * over `plugin://`), and CodeMirror merges equal-named sections.
 */
export const SLASH_SECTION_TEMPLATES = { name: 'Templates', rank: 0 } as const;
export const SLASH_SECTION_FORMATTING = { name: 'Formatting', rank: 1 } as const;

/** What the surface hands the source so it can offer the built-in Entry block. */
export interface SlashSourceOptions {
  /** The entry block as it would be inserted right now (heading with the time). */
  entryText?: () => string;
}

/**
 * The preview card beside the list: a small caption, the snippet as
 * plain text, and the key hint. Styled globally (`src/styles.css`,
 * `.slash-preview*`) so the templates plugin's cards look identical.
 */
export function slashPreviewCard(title: string, snippet: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'slash-preview';
  const head = document.createElement('div');
  head.className = 'slash-preview-head';
  head.textContent = `Preview · ${title}`;
  const body = document.createElement('pre');
  body.className = 'slash-preview-body';
  body.textContent = snippet;
  const foot = document.createElement('div');
  foot.className = 'slash-preview-foot';
  foot.textContent = 'Enter to insert';
  card.append(head, body, foot);
  return card;
}

/**
 * Replaces the typed `/query` by `text` as one change, the caret at the
 * end of the snippet's first line (for the Entry block: right after the
 * time, where the topic goes).
 */
export function insertSlashSnippet(view: EditorView, text: string, from: number, to: number): void {
  const firstLine = text.indexOf('\n');
  const caret = from + (firstLine === -1 ? text.length : firstLine);
  view.dispatch({
    changes: { from, to, insert: text },
    selection: EditorSelection.cursor(caret),
    scrollIntoView: true,
    userEvent: 'input.slashCommand',
  });
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
  return makeSlashCommandSource()(context);
}

/**
 * The source with the built-in Entry block wired in (`MarkdownSurface`
 * passes the composer over the active entry pattern).
 */
export function makeSlashCommandSource(
  opts: SlashSourceOptions = {},
): (context: CompletionContext) => CompletionResult | null {
  return (context) => slashResult(context, opts);
}

function slashResult(context: CompletionContext, opts: SlashSourceOptions): CompletionResult | null {
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
  const options: Completion[] = [];
  const entryText = opts.entryText;
  if (entryText !== undefined && 'entry'.startsWith(query)) {
    options.push({
      label: 'Entry',
      detail: 'Time, topic, tags',
      type: 'slash',
      section: SLASH_SECTION_TEMPLATES,
      info: () => slashPreviewCard('Entry', entryText()),
      apply: (view, _completion, from, to) => insertSlashSnippet(view, entryText(), from, to),
    });
  }
  for (const cmd of matches) {
    options.push({
      label: cmd.label,
      type: 'slash',
      section: SLASH_SECTION_FORMATTING,
      apply: (view, _completion, from, to) => applySlash(view, cmd.action, from, to),
    });
  }
  if (options.length === 0) {
    return null;
  }
  // `filter: false` -- CodeMirror would fuzzy-match the labels against the
  // query text (`/`, `/head`), and no label contains a slash, so every
  // option would be dropped and the popup would never open. The list is
  // already narrowed by the startsWith check above. No `validFor` either:
  // with filtering off, a cached result would keep showing all commands
  // while typing on -- the source re-runs per keystroke instead.
  return { from: token.from, options, filter: false };
}
