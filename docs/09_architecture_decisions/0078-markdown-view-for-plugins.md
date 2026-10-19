# 0078 — The host's Markdown editor as a plugin building block (`ui.createMarkdownView`)

- Status: accepted (2026-10-19, SDK 1.30; owner request, outside the list — follow-up of milestone 86)
- Companion: [ADR-0044](0044-runtime-plugin-system.md) (plugins are plain DOM; the SDK is the contract) and
  [ADR-0057](0057-ui-refinement-icon-chrome-anthrazit-and-slash-capture.md) (`ui.createTagField` is the precedent:
  base chrome handed to plugins as an element)

## Context

The tickets board needed three text surfaces that all want the Markdown editor's rendering and none is a vault
document: the fleet daemon's log (a hand-built `<pre>` until now), the worker transcript of a takeover tab and its
prompt box. A plugin pane is plain DOM, so it could not embed the editor; the only editor reachable was a real
document tab (a vault file or a scratch tab), which brings save prompts, dirty marks and a file that has to live
somewhere.

Extracting the editor into a framework-free module was considered: `MarkdownSurface` injects thirteen Angular
services (themes, vault, wikilinks, tags, keybindings, spellcheck, …), so a clean extraction is a large refactor that
buys nothing the seam below does not.

## Decision

`DreyPluginApi.ui.createMarkdownView(opts)` returns `{ element, setContent, getContent, setReadOnly, focus,
dispose }`. The host instantiates the existing `MarkdownSurface` outside a template (`createComponent` over the root
environment, one change-detection pass) and hands its host element to the plugin. Options: `content`, `mode` (`live` default, `view` = the rendered read-only reading mode, `source`), `readOnly`,
`compact` + `submitOnEnter` + `onSubmit` (the prompt-box look), `placeholder`, `onChange`.

- Not bound to any document: no tab, no save, no vault file, no document identity.
- `setContent` follows the tail while the view is scrolled to the bottom and leaves the position alone otherwise
  (the surface's own stick-to-bottom rule) — a log or transcript needs nothing more.
- Additive: SDK minor 29 → 30. Implementation `src/app/plugin-host/markdown-view.ts` (spec: mounts under TestBed,
  replaces text read-only, tolerates calls after `dispose`).

## Later change — `ui.highlightCode` (SDK 1.31)

A plugin that renders code itself (the assistant's chat answers: fenced blocks) must not carry a tokenizer of its own
nor import `@codemirror/*` (rule 1). `ui.highlightCode(code, lang)` resolves the grammar from the same
`@codemirror/language-data` catalogue notes use (loaded on demand), parses with Lezer and returns `{ text, className }`
runs coloured by the active theme's `HighlightStyle` (Cyberpunk's own, the Drey token style otherwise; the style sheet
is mounted once by a throwaway view). `null` = unknown language. Additive: SDK minor 30 → 31.

## Consequences

- One renderer for every log-like surface. The chain log is the first user (one paragraph per line, no fence — a fence would end up in every copy); the
  takeover tab's transcript and prompt box will be the next.
- A plain-text source must be wrapped for Markdown (`asParagraphs` in the tickets plugin escapes only what would change a line) or its line breaks and
  `*`/`#` are read as Markdown.
- The surface carries the host's full editor weight (CodeMirror, Live Preview); a plugin mounting many views at once
  pays for each. Mount one per pane.
