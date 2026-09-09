# 36. Non-Markdown files open in a read-oriented code mode

## Status

Accepted. A small follow-up to the editor work, prompted by the project
owner noticing that opening a `.cpp` / `.json` file showed it as
unhighlighted plain text in Live Preview.

## Context

`MarkdownSurface` (the one reused CodeMirror surface — full-page editor,
entry drawer, assistant composer) hard-wired the Markdown language into its
static extension list, alongside the Markdown-only chrome: `#tag`
autocomplete, the `#tag` pills, link activation, inline spellcheck and the
frontmatter fold.

The Files panel already opens any non-image file as a text tab (images get
their own viewer tab, ADR-0026), so a `.cpp`, `.json`, `.ts`, `.py`, `.css`
… file lands in this surface. There it read as plain text, in Live Preview
mode (which only renders Markdown), with `#include` / `#define` styled as
`#tag` pills and every identifier underlined by the spellchecker.

## Decision

**The active tab's file extension selects the editor language, and a
non-Markdown file opens in a stripped-down code mode.**

- **`MarkdownSurface` gains a `languageFilename` input and a language
  `Compartment`**, mirroring the existing `modeCompartment` /
  `themeCompartment` pattern. `.md` / `.markdown` / `.mdx` / `null` → the
  full Markdown bundle (`markdownBundle()`: grammar + `#tag` autocomplete +
  pills + link activation + spellcheck + frontmatter fold). Anything else →
  `LanguageDescription.matchFilename(languages, name)` from
  `@codemirror/language-data` (already a dependency, via
  `@codemirror/lang-markdown`'s fenced-code support), lazily `load()`ed and
  swapped in — token-guarded against out-of-order resolution exactly like
  the theme load. An unknown extension → plain text (`[]`). A
  `currentLangKey` guard skips a no-op reconfigure so switching between two
  Markdown tabs never tears down the frontmatter fold's `StateField`.
- **Syntax colours are unchanged.** `dreyHighlightStyle`
  (`editor-theme.ts`) already carries a complete token set for nested
  fenced-code languages; the language compartment only adds the grammar
  that emits those tags. A published `@uiw` theme (ADR-0035) ships its own
  `syntaxHighlighting`, so it colours code too.
- **`EditorService`**: `makeDoc` opens a non-Markdown file in `'source'`
  mode (Live Preview is Markdown-only); `setViewMode` refuses a switch to
  `'live'` for such a tab; a new `activeIsMarkdown` computed drives the
  `⋯` menu, which hides the Live Preview / Source items for a code tab.
- **No new dependencies.** The `@codemirror/lang-*` grammars resolve today
  as transitive deps of `@codemirror/language-data`; they are pulled as
  lazy chunks on first use.

Rejected: a full read/write code editor (line-number-on-by-default,
no-wrap horizontal scroll, per-language indent). Out of scope — Drey is a
note vault; opening a code file is for reference, and the shared surface
should stay one surface.

## Consequences

- Opening a code file from the Files panel now shows real syntax
  highlighting, in source mode, with no Markdown affordances.
- One surface, one `EditorView`, still serves every tab; the language is
  just another compartment.
- Switching from a code tab back to a Markdown tab that was left expanded
  re-adds the frontmatter fold `StateField` fresh; `MarkdownSurface`
  re-asserts the owner's remembered expanded state after the swap.
- Live Preview extensions, image paste and the tag search are all
  Markdown-only by construction now — a code file cannot trigger them.
- `.txt` and extensionless files open as plain text (no grammar, no
  Markdown chrome), which is the intended neutral fallback.
