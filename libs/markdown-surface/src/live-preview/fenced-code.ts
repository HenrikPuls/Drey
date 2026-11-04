/**
 * The language token of a fenced-code info string -- the `mermaid` in
 * ` ```mermaid `. Pure and dependency-free so it can be unit-tested on its
 * own; `block-render.ts` uses it to decide whether a fence renders as a
 * Mermaid diagram.
 *
 * CommonMark allows extra words after the language word; a bare token is
 * all mermaid ever emits, but taking the first whitespace-delimited token
 * (lower-cased) keeps the check robust either way.
 */
export function fenceLang(info: string): string {
  const first = info.trim().split(/\s+/)[0];
  return first ? first.toLowerCase() : '';
}
