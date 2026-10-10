import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';

/**
 * `/diagram` in the editor's slash menu (ADR-0064): one entry in the
 * "Formatting" section, beside the base commands -- CodeMirror merges
 * sections of the same name across completion sources. Choosing it creates
 * a diagram beside the note and replaces the typed `/dia…` with its embed.
 *
 * Built from the host's CodeMirror modules only (ADR-0044 rule 1); the
 * caret gates mirror the base slash source and the templates plugin's.
 */

/** Same name and rank as the base editor's section (`slash-commands.ts`). */
const SECTION = { name: 'Formatting', rank: 1 } as const;
const LABEL = 'Diagram';

/** Syntax nodes a slash menu stays out of: code, links, raw HTML. */
const BLOCKED_NODES = new Set([
  'InlineCode',
  'FencedCode',
  'CodeText',
  'CodeMark',
  'CodeInfo',
  'Link',
  'Image',
  'URL',
  'Autolink',
  'HTMLBlock',
  'HTMLTag',
  'Comment',
]);

/** Whether `pos` sits inside a leading `---` frontmatter block. */
export function inFrontmatter(doc: string, pos: number): boolean {
  if (!doc.startsWith('---\n')) {
    return false;
  }
  const close = doc.indexOf('\n---', 3);
  return close === -1 || pos <= close + 4;
}

/** Whether a typed `/query` (without the slash) should offer the entry. */
export function matchesDiagram(query: string): boolean {
  return LABEL.toLowerCase().startsWith(query.toLowerCase());
}

/**
 * `create` makes the diagram file and hands its embed Markdown
 * (`![diagram](…)`) to `place` -- before it opens the diagram tab, while
 * this editor is still on screen.
 */
export function diagramSlashExtension(
  api: DreyPluginApi,
  create: (place: (markdown: string) => void) => Promise<void>,
): unknown {
  const { language, langMarkdown } = api.editor.cm;

  const apply = (view: EditorView, from: number, to: number): void => {
    void create((markdown) => {
      // Creating is async: only replace when the typed `/query` is still there.
      if (!view.state.sliceDoc(from, to).startsWith('/')) {
        return;
      }
      view.dispatch({
        changes: { from, to, insert: markdown },
        selection: { anchor: from + markdown.length },
        scrollIntoView: true,
        userEvent: 'input.slashCommand',
      });
    });
  };

  const source = (context: CompletionContext): CompletionResult | null => {
    const token = context.matchBefore(/\/[\w-]*/);
    if (!token) {
      return null;
    }
    if (token.from > 0 && !/\s/.test(context.state.sliceDoc(token.from - 1, token.from))) {
      return null;
    }
    if (!matchesDiagram(token.text.slice(1))) {
      return null;
    }
    if (inFrontmatter(context.state.sliceDoc(), context.pos)) {
      return null;
    }
    for (
      let node: { name: string; parent: unknown } | null = language
        .syntaxTree(context.state)
        .resolveInner(context.pos, -1);
      node !== null;
      node = node.parent as { name: string; parent: unknown } | null
    ) {
      if (BLOCKED_NODES.has(node.name)) {
        return null;
      }
    }
    const option: Completion = {
      label: LABEL,
      detail: 'draw.io',
      type: 'slash',
      section: SECTION,
      apply: (view, _completion, from, to) => apply(view, from, to),
    };
    // `filter: false` as in the base source: no label contains the typed
    // slash, so CodeMirror's own filter would drop the entry.
    return { from: token.from, options: [option], filter: false };
  };

  return langMarkdown.markdownLanguage.data.of({ autocomplete: source });
}
