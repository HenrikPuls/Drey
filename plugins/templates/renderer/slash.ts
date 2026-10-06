import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import type { TemplateEntry, TemplateLibrary } from './library.js';

/**
 * The templates' half of the `/` menu (milestone 43): every template of
 * the library as an option in the menu's **Templates** section, with a
 * preview card beside the selected row. The base editor owns the other
 * half (`src/app/editor/slash-commands.ts` — the built-in Entry block and
 * the Formatting section); CodeMirror merges the two sources into one
 * popup, and equal-named sections into one group.
 *
 * Same trigger rule as the base source — `/` at a line start or after
 * whitespace, silent in code, links, raw HTML and frontmatter — so the
 * popup never opens for one source where the other would stay quiet.
 */

/** Must match the base source's section (merged by name). */
const SECTION = { name: 'Templates', rank: 0 } as const;

/** Syntax nodes the menu stays out of (mirrors the base Markdown-context gate). */
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
  'ProcessingInstruction',
]);

const PREVIEW_MAX_LINES = 12;

/** The preview card — same DOM and classes as the base editor's (`.slash-preview*`, global sheet). */
export function previewCard(title: string, snippet: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'slash-preview';
  const head = document.createElement('div');
  head.className = 'slash-preview-head';
  head.textContent = `Preview · ${title}`;
  const body = document.createElement('pre');
  body.className = 'slash-preview-body';
  body.textContent = clip(snippet);
  const foot = document.createElement('div');
  foot.className = 'slash-preview-foot';
  foot.textContent = 'Enter to insert';
  card.append(head, body, foot);
  return card;
}

/** The first lines of a snippet, with an ellipsis line when it is longer. */
export function clip(snippet: string, maxLines = PREVIEW_MAX_LINES): string {
  const lines = snippet.replace(/\s+$/, '').split('\n');
  return lines.length <= maxLines ? lines.join('\n') : [...lines.slice(0, maxLines), '…'].join('\n');
}

/** `templates/meetings/1-1.md` under `templates` → `meetings`; top-level files → `General`. */
export function categoryOf(entry: TemplateEntry, libraryDir: string): string {
  const inner = entry.relativePath.startsWith(`${libraryDir}/`)
    ? entry.relativePath.slice(libraryDir.length + 1)
    : entry.relativePath;
  const slash = inner.indexOf('/');
  return slash === -1 ? 'General' : inner.slice(0, slash);
}

function inFrontmatter(doc: string, pos: number): boolean {
  if (!doc.startsWith('---\n')) {
    return false;
  }
  const close = doc.indexOf('\n---', 3);
  return close === -1 || pos <= close + 4;
}

/** The CodeMirror extension: a completion source on the Markdown language data. */
export function templateSlashExtension(api: DreyPluginApi, library: TemplateLibrary): unknown {
  const { language, langMarkdown } = api.editor.cm;

  const apply = (view: EditorView, entry: TemplateEntry, from: number, to: number): void => {
    void library.render(entry.relativePath).then((text) => {
      // The read is async: only replace when the typed `/query` is still there.
      if (text === null || !view.state.sliceDoc(from, to).startsWith('/')) {
        return;
      }
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
        scrollIntoView: true,
        userEvent: 'input.slashCommand',
      });
      library.markUsed(entry.relativePath);
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

    const query = token.text.slice(1).toLowerCase();
    const matches = library.all.filter((entry) => entry.name.toLowerCase().startsWith(query));
    if (matches.length === 0) {
      return null;
    }
    const options: Completion[] = matches.map((entry) => ({
      label: entry.name,
      detail: categoryOf(entry, library.dir),
      type: 'slash',
      section: SECTION,
      info: () =>
        library
          .render(entry.relativePath)
          .then((text) => previewCard(entry.name, text ?? 'This template could not be read.')),
      apply: (view, _completion, from, to) => apply(view, entry, from, to),
    }));
    // `filter: false` for the same reason as the base source: no label
    // contains the typed slash, so CodeMirror's own filter would drop all.
    return { from: token.from, options, filter: false };
  };

  return langMarkdown.markdownLanguage.data.of({ autocomplete: source });
}
