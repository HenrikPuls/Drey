/**
 * Type shim for `markdown-it-footnote` (no shipped declarations). The
 * plugin is a rule pack used through `md.use(footnote)` — its shape is
 * exactly a simple plugin: one function taking the instance.
 */
declare module 'markdown-it-footnote' {
  import type { MarkdownIt } from 'markdown-it';
  const footnote: (md: MarkdownIt) => void;
  export default footnote;
}
