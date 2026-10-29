/**
 * Fence highlighting for every markdown-it render (T-0051): the same
 * Lezer grammars and the same colors the editor uses, so a ```ts fence
 * in a Live Preview table cell or HTML region reads like the source
 * editor. Zero new dependencies: `@codemirror/language-data` ships the
 * grammar index, `@lezer/highlight`'s `highlightTree` walks the parse.
 *
 * The grammars load lazily (dynamic imports behind
 * `LanguageDescription.load`), and markdown-it's `highlight` option is
 * synchronous — so the FIRST fence of a language renders uncolored,
 * `ensureFenceLanguage` starts the load, and the next render (any doc
 * edit re-runs the Live Preview field; each view render re-runs the
 * instance) is colored. `onFenceGrammars` tells a surface that wants
 * immediate refreshes when a grammar arrived.
 *
 * Inline `style` attributes, not classes: the output must carry its
 * colors into any document (the takeover tab's Markdown view, the HTML
 * region), not only ones that mounted the editor's StyleModule.
 */
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightTree, type Highlighter, type Tag } from '@lezer/highlight';
import type { Parser } from '@lezer/common';
import { dreyHighlightStyle } from './editor-theme';

/** The css properties a HighlightStyle rule may carry that we forward inline. */
const CSS_PROPS: readonly string[] = [
  'color',
  'fontStyle',
  'fontWeight',
  'textDecoration',
  'fontFamily',
  'fontSize',
];

/** One rule's css text (`color: …;fontStyle: …;`), '' when it styles nothing. */
const cssOf = (spec: { readonly [prop: string]: unknown }): string =>
  CSS_PROPS.filter((prop) => typeof spec[prop] === 'string')
    .map((prop) => `${prop}:${String(spec[prop])};`)
    .join('');

/**
 * `dreyHighlightStyle`'s rules as tag → inline css, with the same
 * precedence `@lezer/highlight`'s tag highlighter uses: a later rule for
 * the same tag wins, and a node's tag matches through itself and its
 * parents (most specific first). Tags are canonical instances — the
 * grammars import the same module — so identity keys work.
 */
const cssByTag = new Map<Tag, string>();
for (const spec of dreyHighlightStyle.specs) {
  const css = cssOf(spec as { readonly [prop: string]: unknown });
  if (css === '') {
    continue;
  }
  for (const tag of spec.tag instanceof Array ? spec.tag : [spec.tag as Tag]) {
    cssByTag.set(tag, css);
  }
}

/** Resolves a node's tags to the inline css of the first matching rule. */
const inlineStyleHighlighter: Highlighter = {
  style: (tags: readonly Tag[]): string | null => {
    for (const tag of tags) {
      for (const candidate of tag.set) {
        const css = cssByTag.get(candidate);
        if (css !== undefined) {
          return css;
        }
      }
    }
    return null;
  },
};

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The language of a fence info word (`ts`, `python`, …), when the index knows one. */
export function fenceLanguageOf(lang: string): LanguageDescription | null {
  const word = lang.trim().split(/[\s{]/)[0] ?? '';
  if (word === '') {
    return null;
  }
  return LanguageDescription.matchLanguageName(languages, word, false);
}

/** Loaded parsers by language name; null = loaded and not usable (no parser). */
const parsers = new Map<string, Parser | null>();
const listeners = new Set<() => void>();

/**
 * Loads (once) the grammar behind a fence info word. True when the
 * parser is cached and `highlightFence` will color it from now on.
 */
export function ensureFenceLanguage(lang: string): Promise<boolean> {
  const desc = fenceLanguageOf(lang);
  if (desc === null) {
    return Promise.resolve(false);
  }
  const cached = parsers.get(desc.name);
  if (cached !== undefined) {
    return Promise.resolve(cached !== null);
  }
  return desc
    .load()
    .then((support) => {
      // Stream languages (a few legacy entries) carry a parser without
      // parse-to-tree support for highlightTree — those fences stay
      // plain. A missing parser reads as null in the cache either way.
      const parser: Parser | null = support.language.parser ?? null;
      parsers.set(desc.name, parser);
      if (parser !== null) {
        for (const listener of listeners) {
          listener();
        }
      }
      return parser !== null;
    })
    .catch(() => {
      parsers.set(desc.name, null);
      return false;
    });
}

/** Calls `listener` once a grammar finished loading; returns its unsubscribe. */
export function onFenceGrammars(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The markdown-it `highlight` option: `code` from a ` ```lang ` fence as
 * HTML with inline-styled `<span>`s. `''` (unknown language, grammar
 * not loaded yet) makes markdown-it fall back to its own escaped plain
 * rendering — never a wrong-colored guess.
 */
export function highlightFence(code: string, lang: string): string {
  const desc = fenceLanguageOf(lang);
  if (desc === null) {
    return '';
  }
  const parser = parsers.get(desc.name);
  if (parser === undefined) {
    void ensureFenceLanguage(lang);
    return '';
  }
  if (parser === null) {
    return '';
  }
  const tree = parser.parse(code);
  let html = '';
  let at = 0;
  highlightTree(tree, inlineStyleHighlighter, (from, to, css) => {
    if (from > at) {
      html += escapeHtml(code.slice(at, from));
    }
    html += `<span style="${css}">${escapeHtml(code.slice(from, to))}</span>`;
    at = to;
  });
  html += escapeHtml(code.slice(at));
  return html;
}
