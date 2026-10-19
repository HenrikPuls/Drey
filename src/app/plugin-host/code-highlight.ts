import { LanguageDescription, type HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { EditorView } from '@codemirror/view';
import { highlightTree } from '@lezer/highlight';
import type { HighlightedSpan } from '../../../shared/plugin-api/renderer';

/**
 * `ui.highlightCode` (SDK 1.31): the editor's own syntax colouring for a
 * piece of code outside any editor. The language is resolved from the same
 * `@codemirror/language-data` catalogue fenced code in notes uses (loaded
 * on demand), parsed with its Lezer grammar and coloured by the theme's
 * `HighlightStyle` -- so a chat answer and a note read the same.
 */

const mounted = new WeakSet<HighlightStyle>();

/**
 * A `HighlightStyle`'s CSS is mounted by a view that uses it; with no editor
 * open yet there is none. A throwaway view installs the style sheet in the
 * document once and goes away -- the sheet stays.
 */
function ensureStyleMounted(style: HighlightStyle): void {
  if (mounted.has(style)) {
    return;
  }
  mounted.add(style);
  const host = document.createElement('div');
  host.style.display = 'none';
  document.body.appendChild(host);
  const view = new EditorView({ parent: host, extensions: [syntaxHighlighting(style)] });
  view.destroy();
  host.remove();
}

/** Coloured runs for `code`, or `null` when no grammar matches `lang`. */
export async function highlightCode(
  code: string,
  lang: string,
  style: HighlightStyle,
): Promise<readonly HighlightedSpan[] | null> {
  const name = lang.trim();
  if (name === '') {
    return null;
  }
  const description =
    LanguageDescription.matchLanguageName(languages, name, false) ??
    LanguageDescription.matchFilename(languages, `x.${name}`);
  if (description === null) {
    return null;
  }
  const support = await description.load();
  ensureStyleMounted(style);
  const tree = support.language.parser.parse(code);
  const spans: HighlightedSpan[] = [];
  let pos = 0;
  highlightTree(tree, style, (from, to, className) => {
    if (from > pos) {
      spans.push({ text: code.slice(pos, from), className: '' });
    }
    spans.push({ text: code.slice(from, to), className });
    pos = to;
  });
  if (pos < code.length) {
    spans.push({ text: code.slice(pos), className: '' });
  }
  return spans;
}
