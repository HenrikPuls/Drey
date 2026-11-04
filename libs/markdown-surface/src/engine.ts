import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { EditorState, Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import { extendedMarkdown } from './markdown-extensions';
import { livePreview, type LivePreviewConfig } from './live-preview';

/**
 * The one engine both surfaces share (milestone 133): the desktop editor
 * (`MarkdownSurface`, Angular) and the Mission Control client
 * (`createMarkdownView`, plain DOM) build their CodeMirror state from these
 * three pieces, so the dialect and the three modes can never drift apart.
 */

/** Live Preview (edit in place), View (read-only rendered), Source (raw). */
export type SurfaceMode = 'live' | 'view' | 'source';

/**
 * The Markdown language plus the extended dialect (milestone 71):
 * `==highlight==`, `$…$` / `$$…$$` math, footnotes, curated `:emoji:` — on
 * top of GFM and Pandoc sub/superscript, which `markdownLanguage` already
 * parses. `@lezer/markdown`'s own `Emoji` parser is dropped (any `name:`
 * matched, so a timestamp like `2026-09-09T00:03:48` had its `:03:` slice
 * coloured as an emoji); the curated replacement only matches known GitHub
 * names. Nested fenced-code parsers come from `@codemirror/language-data`;
 * HTML tag autocompletion is off — a note editor wants no popup on `<`.
 */
export function markdownDialect(): Extension {
  return markdown({
    base: markdownLanguage,
    codeLanguages: languages,
    completeHTMLTags: false,
    extensions: [{ remove: ['Emoji'] }, ...extendedMarkdown],
  });
}

/** Blocks user input while still allowing owner-driven document pushes. */
export const readOnlyExtension: Extension = [EditorView.editable.of(false), EditorState.readOnly.of(true)];

/** True when the mode forbids typing whatever the owner says. */
export function modeForcesReadOnly(mode: SurfaceMode): boolean {
  return mode === 'view';
}

/**
 * What a mode adds on top of the base extensions. Source adds nothing
 * (the raw Markdown with syntax colours); View renders everything and
 * ignores the selection, links open on a plain click, and the editing
 * chrome on embeds (view-source, zoom lens, resize grip) is hidden; Live
 * Preview reveals syntax around the selection.
 */
export function surfaceModeExtensions(mode: SurfaceMode, live: LivePreviewConfig): Extension {
  if (mode === 'source') {
    return [];
  }
  if (mode === 'view') {
    return [
      livePreview(live, { revealSelection: false }),
      EditorView.theme({
        '.lp-edit, .lp-lens, .lp-resize': { display: 'none' },
        '.lp-task input': { pointerEvents: 'none' },
      }),
    ];
  }
  return livePreview(live);
}
