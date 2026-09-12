import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { EditorState, Extension, Range } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { frontmatterEnd } from '../markdown-frontmatter';

/**
 * Obsidian-style `[[wikilinks]]` (req-20), built the same way as the `#tag`
 * pills (ADR-0017's decoration route -- no Lezer node, so no parser
 * extension): a regex finds `[[target]]`, `[[target#heading]]`,
 * `[[target|alias]]` and `[[target#heading|alias]]` (plus same-file
 * `[[#heading]]`), a mark decoration styles the span and carries the parts
 * as `data-*` attributes, and a `Ctrl`/`Cmd`-mousedown hands them to the
 * owner's `onActivate` (the `WikilinkService` resolves and opens, or
 * creates a missing note).
 *
 * Like `link-open.ts`, the pure parts (`extractWikilinks`,
 * `wikilinkDecorations`, the completion source) are unit-tested; the
 * extension only adds the click handler and the theme. The marks live in
 * the language compartment -- styled and clickable in Live Preview *and*
 * source mode; only the bracket concealing is Live-Preview-only (the
 * ADR-0009 conceal layer picks it up from `extractWikilinks`).
 */

export interface WikilinkOccurrence {
  /** Position of the opening `[` within the scanned text. */
  index: number;
  /** Length of the whole `[[...]]` span. */
  length: number;
  /** Target (path or note name), trimmed; `''` for a same-file `[[#heading]]`. */
  target: string;
  /** `#heading` anchor, trimmed, without the `#`. */
  anchor: string | null;
  /** Display alias after `|`, trimmed. */
  alias: string | null;
  /** End of `target[#anchor]`, relative to `index` -- a `|` or the `]]` follows. */
  contentEnd: number;
  /** Start of the alias text, relative to `index` (only when `alias`). */
  aliasStart: number;
}

const WIKILINK = /\[\[([^\[\]#|\n]*)(?:#([^\[\]|\n]+))?(?:\|([^\[\]\n]+))?\]\]/g;

/**
 * Every wikilink in `text`. Brackets inside the target are rejected by the
 * character classes (no nested `[`/`]`); `#` ends the target and starts the
 * anchor; `|` ends target/anchor and starts the alias. Occurrences with an
 * empty target *and* no anchor (`[[]]`, `[[|x]]`) are skipped.
 */
export function extractWikilinks(text: string): WikilinkOccurrence[] {
  const out: WikilinkOccurrence[] = [];
  for (const match of text.matchAll(WIKILINK)) {
    const target = (match[1] ?? '').trim();
    const anchor = match[2] !== undefined ? match[2].trim() : null;
    const alias = match[3] !== undefined ? match[3].trim() : null;
    if (target === '' && anchor === null) {
      continue;
    }
    const index = match.index;
    // match[0] is `[[<raw target>][#<raw anchor>][|<raw alias>]]`; the raw
    // (untrimmed) target spans to the first `#` / `|` / `]]`.
    const rawTargetEnd = 2 + match[1].length;
    const contentEnd =
      anchor !== null ? rawTargetEnd + 1 + match[2].length : rawTargetEnd;
    out.push({
      index,
      length: match[0].length,
      target,
      anchor,
      alias,
      contentEnd,
      aliasStart: contentEnd + 1,
    });
  }
  return out;
}

const markCache = new Map<string, Decoration>();
function wikilinkMark(resolved: boolean, attrs: Record<string, string>): Decoration {
  // Decorations are compared by identity across rebuilds -- cache per full
  // attribute set, or [[Plan#A]] and [[Plan]] would share a data-anchor.
  const cacheKey = `${resolved ? 'r' : 'u'}|${attrs['data-wikilink']}|${attrs['data-anchor'] ?? ''}|${attrs['data-alias'] ?? ''}`;
  let deco = markCache.get(cacheKey);
  if (!deco) {
    deco = Decoration.mark({
      class: resolved ? 'cm-wikilink' : 'cm-wikilink cm-wikilink-unresolved',
      attributes: attrs,
    });
    markCache.set(cacheKey, deco);
  }
  return deco;
}

function insideCode(state: EditorState, pos: number): boolean {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
  for (; node !== null; node = node.parent) {
    if (/Code|Comment/.test(node.name)) {
      return true;
    }
  }
  return false;
}

/** The `resolve` probe: does this wikilink target exist in the vault? */
export type WikilinkResolve = (target: string) => boolean;

/**
 * The `data-wikilink` mark decorations over the visible ranges -- the
 * wikilink twin of `linkTargetDecorations`. Mirrors the tag pills' guards:
 * widened to whole lines (the regex keys off nothing positional, but the
 * slice boundary must not cut a span), skipped inside frontmatter and code.
 */
export function wikilinkDecorations(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
  resolve: WikilinkResolve,
): DecorationSet {
  const deco: Range<Decoration>[] = [];
  const fmEnd = frontmatterEnd(state.sliceDoc());

  for (const range of ranges) {
    const from = state.doc.lineAt(range.from).from;
    const to = state.doc.lineAt(range.to).to;
    const text = state.sliceDoc(from, to);

    for (const occ of extractWikilinks(text)) {
      const start = from + occ.index;
      if (start < fmEnd || start + occ.length > state.doc.length || insideCode(state, start)) {
        continue;
      }
      const attrs: Record<string, string> = { 'data-wikilink': occ.target };
      if (occ.anchor !== null) {
        attrs['data-anchor'] = occ.anchor;
      }
      if (occ.alias !== null) {
        attrs['data-alias'] = occ.alias;
      }
      deco.push(wikilinkMark(resolve(occ.target), attrs).range(start, start + occ.length));
    }
  }

  return Decoration.set(deco, true);
}

/**
 * @param onActivate called with the target and the `#heading` anchor (or
 *   null) when a marked wikilink is `Ctrl`/`Cmd`-clicked.
 */
export function wikilinks(options: {
  resolve: WikilinkResolve;
  onActivate?: (target: string, anchor: string | null) => void;
}): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = wikilinkDecorations(view.state, view.visibleRanges, options.resolve);
      }

      update(update: ViewUpdate): void {
        if (
          update.docChanged ||
          update.viewportChanged ||
          syntaxTree(update.state) !== syntaxTree(update.startState)
        ) {
          this.decorations = wikilinkDecorations(
            update.state,
            update.view.visibleRanges,
            options.resolve,
          );
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(event) {
          if (!options.onActivate || (!event.ctrlKey && !event.metaKey)) {
            return false;
          }
          const el = (event.target as HTMLElement | null)?.closest('.cm-wikilink');
          const target = el?.getAttribute('data-wikilink');
          if (target === null || target === undefined) {
            return false;
          }
          event.preventDefault();
          options.onActivate(target, el?.getAttribute('data-anchor') ?? null);
          return true;
        },
      },
    },
  );

  return [plugin, wikilinkTheme];
}

const wikilinkTheme = EditorView.theme({
  '.cm-wikilink': {
    color: 'var(--accent)',
    cursor: 'pointer',
  },
  '.cm-wikilink:hover': {
    textDecoration: 'underline',
  },
  // A target that does not resolve: muted with a dotted underline -- visibly
  // "not there yet" (Ctrl+click creates it), but still a link.
  '.cm-wikilink-unresolved': {
    color: 'var(--text-5)',
    textDecoration: 'underline dotted',
    textUnderlineOffset: '3px',
  },
});

/** One completable note: display `name` (file basename without extension),
 * the full `path` it lives at, `dir` (the folder, for the popup's detail
 * column), and `target` -- the text the completion inserts between the
 * brackets (basename when unique vault-wide, else the extension-less path;
 * resolution appends `.md`). */
export interface WikilinkCandidate {
  name: string;
  path: string;
  dir: string;
  target: string;
}

/**
 * `[[` completion over the vault's note list -- the tag-completion twin
 * (`makeTagCompletionSource`). Filters case-insensitively by basename
 * prefix, falling back to a substring match on the vault path (so
 * `proj/` narrows to notes under folders). Inserts `[[<target>]]`, closing
 * the brackets the user already opened only in text, not in the token --
 * the typed `[[` is replaced whole.
 *
 * v1 completes note names only; a `#heading` anchor is typed by hand.
 */
export function makeWikilinkCompletionSource(
  getNotes: () => readonly WikilinkCandidate[],
): (context: CompletionContext) => Promise<CompletionResult | null> | CompletionResult | null {
  return (context: CompletionContext): CompletionResult | null => {
    const token = context.matchBefore(/\[\[[^\[\]\n]*/);
    if (!token) {
      return null;
    }
    // A bare `[[` offers nothing until completion is explicitly requested
    // (Mod-Space) -- the tag source's rule.
    const query = token.text.slice(2).toLowerCase();
    if (query === '' && !context.explicit) {
      return null;
    }

    const byName: WikilinkCandidate[] = [];
    const byPath: WikilinkCandidate[] = [];
    for (const note of getNotes()) {
      if (note.name.toLowerCase().startsWith(query)) {
        byName.push(note);
      } else if (note.path.toLowerCase().includes(query)) {
        byPath.push(note);
      }
    }
    const matches = [...byName, ...byPath].slice(0, 100);
    if (matches.length === 0) {
      return null;
    }

    const nameSet = new Set(byName);
    const options = matches.map((note) => ({
      label: note.name,
      apply: `[[${note.target}]]`,
      detail: note.dir,
      boost: nameSet.has(note) ? 0 : -10,
    }));

    // `#`/`|` end the note-name query (anchor / alias follow) -- let the
    // popup close by re-running the source on those keystrokes.
    return { from: token.from, options, validFor: /^\[\[[^\[\]\n|#]*$/u };
  };
}
