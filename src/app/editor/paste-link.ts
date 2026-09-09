import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { frontmatterEnd } from './markdown-frontmatter';

/**
 * Paste a URL onto an empty selection and get a Markdown link
 * (`[url](url)`), with the label pre-selected so a friendlier label can be
 * typed straight over it.
 *
 * `@codemirror/lang-markdown`'s built-in `pasteURLAsLink` only fires when
 * there is a **non-empty** selection to wrap (`[selection](url)`); the
 * empty-caret case just drops the raw text. This fills that gap and leaves
 * the wrap-the-selection case to the built-in.
 *
 * Deliberately conservative: it acts only when the clipboard's plain text
 * is a single bare URL token, the caret sits in ordinary prose (not code /
 * an existing link / the frontmatter), and the paste carries no image
 * payload (so `imagePaste` keeps first claim on those).
 */

/** A lone `http(s)`/`mailto`/`xmpp`/`www.` token -- no inner whitespace. */
const BARE_URL = /^(?:https?:\/\/|mailto:|xmpp:|www\.)\S+$/i;

/** Node names the caret must not be inside -- mirrors lang-markdown's own list. */
const NON_PLAIN_TEXT = /code|horizontalrule|html|link|comment|processing|escape|entity|image|mark|url/i;

/** True when `pos` is inside a construct where injecting link syntax would be wrong. */
function inNonPlainText(view: EditorView, pos: number): boolean {
  const fmEnd = frontmatterEnd(view.state.sliceDoc());
  if (fmEnd > 0 && pos < fmEnd) {
    return true;
  }
  let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, -1);
  while (node) {
    if (NON_PLAIN_TEXT.test(node.name)) {
      return true;
    }
    node = node.parent;
  }
  return false;
}

export function pasteUrlAsMarkdownLink(): Extension {
  return EditorView.domEventHandlers({
    paste: (event, view) => {
      const main = view.state.selection.main;
      if (!main.empty) {
        return false; // lang-markdown's pasteURLAsLink wraps the selection
      }
      const data = event.clipboardData;
      if (!data || data.types.includes('Files')) {
        return false;
      }
      let url = (data.getData('text/plain') || '').trim();
      if (!BARE_URL.test(url)) {
        return false;
      }
      if (/^www\./i.test(url)) {
        url = `https://${url}`;
      }
      if (inNonPlainText(view, main.from)) {
        return false;
      }
      const label = url;
      const insert = `[${label}](${url})`;
      view.dispatch({
        changes: { from: main.from, insert },
        // Select the label so the user can type a nicer one straight away.
        selection: { anchor: main.from + 1, head: main.from + 1 + label.length },
        userEvent: 'input.paste',
        scrollIntoView: true,
      });
      return true;
    },
  });
}
