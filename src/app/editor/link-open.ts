import { syntaxTree } from '@codemirror/language';
import { EditorState, Extension, Range } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { frontmatterEnd } from './markdown-frontmatter';
import { extractWikilinks } from './wikilinks/wikilink';
import { normalizeRelative } from './vault-image';

/**
 * Makes Markdown links in the editor openable with a `Ctrl`/`Cmd`-click
 * (both Live Preview and source mode, like the `#tag` pills). A plain click
 * is left alone so the caret can still be placed inside the link text --
 * except in a read-only state (the view mode), where there is no caret and
 * a plain click opens.
 *
 * Covers `[label](target)`, `<autolink>` and a bare GFM URL. The link-target
 * span is marked with `data-href`; the owner's `onOpen` callback classifies
 * it -- web/mail through `shell.openExternal`, a vault-relative path through
 * the editor's tab-open (see `Editor.activateLink`).
 *
 * Split like `conceal.ts` / `tag-pill.ts`: the pure `linkTargetDecorations`
 * is unit-tested; the extension only adds the click handler and the cursor
 * affordance.
 */

const markCache = new Map<string, Decoration>();
function linkMark(href: string): Decoration {
  let deco = markCache.get(href);
  if (!deco) {
    deco = Decoration.mark({ class: 'cm-lp-link', attributes: { 'data-href': href } });
    markCache.set(href, deco);
  }
  return deco;
}

export function linkTargetDecorations(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): DecorationSet {
  const deco: Range<Decoration>[] = [];
  const fmEnd = frontmatterEnd(state.sliceDoc());
  const tree = syntaxTree(state);

  // `[[wikilinks]]` (req-20): lezer-markdown sees the text between the
  // brackets as a shortcut-reference `Link`; those spans belong to the
  // wikilink plugin's own click handler, so no `data-href` mark here.
  const wikiEnds: { from: number; to: number }[] = [];
  for (const { from, to } of ranges) {
    const lineFrom = state.doc.lineAt(from).from;
    const lineTo = state.doc.lineAt(to).to;
    for (const occ of extractWikilinks(state.sliceDoc(lineFrom, lineTo))) {
      const start = lineFrom + occ.index;
      wikiEnds.push({ from: start, to: start + occ.length });
    }
  }
  const inWiki = (pos: number): boolean =>
    wikiEnds.some((s) => pos >= s.from && pos < s.to);

  for (const { from, to } of ranges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.to <= fmEnd || inWiki(node.from)) {
          return;
        }
        if (node.name === 'Link') {
          const url = node.node.getChild('URL');
          const href = url ? state.sliceDoc(url.from, url.to).trim() : '';
          if (href) {
            deco.push(linkMark(href).range(node.from, node.to));
          }
          return false; // the label is inside -- don't also mark a nested URL
        }
        if (node.name === 'Autolink') {
          const href = state
            .sliceDoc(node.from, node.to)
            .replace(/^<|>$/g, '')
            .trim();
          if (href) {
            deco.push(linkMark(href).range(node.from, node.to));
          }
          return false;
        }
        if (node.name === 'URL') {
          // A bare GFM URL: `URL` that is not the (hidden) target of a Link,
          // nor part of an Autolink or an Image.
          const parent = node.node.parent?.name;
          if (parent === 'Link' || parent === 'Autolink' || parent === 'Image') {
            return;
          }
          const href = state.sliceDoc(node.from, node.to).trim();
          if (href) {
            deco.push(linkMark(href).range(node.from, node.to));
          }
        }
        return;
      },
    });
  }

  return Decoration.set(deco, true);
}

/**
 * The link a click inside a rendered widget (a table, an HTML block, a
 * callout …) lands on: those widgets hold markdown-it's HTML, so their
 * links are real `<a href>` elements, and the browser would follow one by
 * navigating the whole window away from the app. `#anchor` links stay
 * in-page (footnotes). `null` when the click is on no such link.
 */
export function widgetLinkHref(target: EventTarget | null): string | null {
  const anchor = target instanceof Element ? target.closest('a[href]') : null;
  const href = anchor?.getAttribute('href')?.trim() ?? '';
  return href && !href.startsWith('#') ? href : null;
}

/**
 * @param onOpen called with the raw link target when a marked link is
 *   `Ctrl`/`Cmd`-clicked, or a link inside a rendered widget is clicked.
 */
export function linkActivation(onOpen: (href: string) => void): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      /**
       * A plain click opens a link in a rendered widget (no caret to place
       * there). A native listener: the widgets ignore their content's
       * events, so CodeMirror's own handlers never see the click.
       */
      private readonly onWidgetClick = (event: MouseEvent): void => {
        const href = widgetLinkHref(event.target);
        if (href === null) {
          return;
        }
        event.preventDefault();
        if (event.button === 0) {
          onOpen(href);
        }
      };

      constructor(private readonly view: EditorView) {
        this.decorations = linkTargetDecorations(view.state, view.visibleRanges);
        view.contentDOM.addEventListener('click', this.onWidgetClick);
        view.contentDOM.addEventListener('auxclick', this.onWidgetClick);
      }

      destroy(): void {
        this.view.contentDOM.removeEventListener('click', this.onWidgetClick);
        this.view.contentDOM.removeEventListener('auxclick', this.onWidgetClick);
      }

      update(update: ViewUpdate): void {
        if (
          update.docChanged ||
          update.viewportChanged ||
          syntaxTree(update.state) !== syntaxTree(update.startState)
        ) {
          this.decorations = linkTargetDecorations(update.state, update.view.visibleRanges);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(event, view) {
          const modifier = event.ctrlKey || event.metaKey;
          // Read-only (the view mode): no caret to place, a plain click opens.
          if (!modifier && !view.state.readOnly) {
            return false;
          }
          const el = (event.target as HTMLElement | null)?.closest('.cm-lp-link');
          const href = el?.getAttribute('data-href');
          if (!href) {
            return false;
          }
          event.preventDefault();
          onOpen(href);
          return true;
        },
      },
    },
  );

  return [plugin, linkTheme];
}

const linkTheme = EditorView.theme({
  '.cm-lp-link': { cursor: 'pointer' },
  '.cm-lp-link:hover': { textDecoration: 'underline' },
});

/**
 * Resolves an in-vault link target to a vault-relative path, or `null` when
 * it is external / unresolvable. `#anchor` and `?query` suffixes are
 * dropped; a target with no extension gets `.md` (so `[note](other)` works).
 * Mirrors `resolveVaultImageUrl` but yields a plain path, not a URL.
 */
export function resolveVaultLinkPath(docPath: string | null, rawHref: string): string | null {
  let href = rawHref.trim();
  if (!href || href.startsWith('#')) {
    return null;
  }
  // External or any explicit scheme -> not an in-vault path.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
    return null;
  }
  href = href.replace(/[#?].*$/, '');
  if (!href) {
    return null;
  }
  href = decodeURIComponentSafe(href);
  const baseDir =
    docPath && docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : '';
  const joined = normalizeRelative(baseDir ? `${baseDir}/${href}` : href);
  if (!joined) {
    return null;
  }
  return /\.[^/]+$/.test(joined) ? joined : `${joined}.md`;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
