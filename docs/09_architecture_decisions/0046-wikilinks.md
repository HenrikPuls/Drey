# 46. `[[Wikilinks]]` — note-to-note links

## Status

Accepted (req-20). Extends the link-activation model of
[ADR-0031](0031-editor-link-activation.md) and the decoration route of
[ADR-0017](0017-tags-as-labels-and-section-index.md); the concealing rides
[ADR-0009](0009-live-preview-decorations.md).

## Context

Notes could only reference each other through regular Markdown links
`[label](path)` — workable but awkward: the path must be right, nothing
helps you type it, and a renamed note breaks the link silently. The owner
asked for Obsidian-style `[[wikilinks]]` that "just work" in the document:
type `[[`, pick a note, `Ctrl`-click to jump — and a link to a note that
does not exist yet should create it.

ADR-0031 had explicitly deferred wikilinks because there is no Lezer node
for them in the configured grammar.

## Decision

A new **base** feature module `src/app/editor/wikilinks/` (no plugin:
wikilinks are navigation like `link-open.ts`; they need `VaultService` +
`EditorService` and own no vault-side index — the Tags plugin exists as a
plugin because its vocabulary and section index are plugin-owned data).

- **Grammar** (`wikilink.ts`): one regex recognises `[[target]]`,
  `[[target#heading]]`, `[[target|alias]]`, `[[target#heading|alias]]` and
  the same-file `[[#heading]]`. The target may contain `/`, spaces, dots
  and unicode; nested brackets are rejected. `#` ends the target (anchor
  follows), `|` ends target/anchor (alias follows). `[[]]` / `[[|x]]` are
  not links. Same decoration route as the `#tag` pills — no Lezer parser
  is added; `markdownBundle()` gains a `wikilinks({ resolve, onActivate })`
  extension and the completion source in the **language** compartment, so
  styling and `Ctrl`/`Cmd`-click work in Live Preview *and* source mode.
- **Rendering**: a mark decoration (`cm-wikilink`, accent colour; plus
  `cm-wikilink-unresolved` — muted with a dotted underline — when
  `resolve` misses) carrying `data-wikilink` / `data-anchor` / `data-alias`.
  The Live Preview conceal layer hides the outer `[[` / `]]` (and the whole
  `target#anchor|` prefix when an alias is present, so only the alias
  shows), revealed when the selection touches the span. Because
  lezer-markdown parses the text between the brackets as a
  shortcut-reference `Link`, the conceal layer and
  `linkTargetDecorations` skip spans the regex claimed, so the inner
  markdown `Link`'s marks and `data-href` never fight the wikilink
  handler.
- **Resolution** (`WikilinkService`): the note index is derived in the
  renderer from `vault.fileTree()` (markdown files only). A target
  containing `/` or an extension is a vault-relative path (`.md` appended
  when bare, case-insensitive); anything else is a basename — unique
  basenames resolve outright, ambiguous ones prefer a sibling of the
  linking note, then the shortest path, then a locale compare (deterministic).
  An empty target resolves to the linking note itself.
- **Activation**: `Ctrl`/`Cmd`-click → `WikilinkService.open(target,
  anchor, fromPath)` — opens the resolved note through `openFileAt`, which
  for a `#heading` anchor first finds the heading's line (open buffer
  first, so unsaved edits count, else the file from disk; falls back to
  the top when the anchor does not exist). **An unresolved target creates
  the note**: `<target>.md` at the implied path (parents auto-created by
  `VaultManager.createFile`), tree reload, then open. An "already exists"
  race still just opens. Unusable targets (`..`, `\`) are reported, not
  created.
- **Completion**: typing after `[[` offers the vault's notes
  (case-insensitive basename-prefix matches first, then path-substring
  matches); the inserted text is the basename when unique vault-wide, else
  the extension-less path. v1 completes note names only — a `#heading`
  anchor is typed by hand.
- **Entry drawer**: wikilinks render and complete there too (same
  surface), and `Ctrl`-click follows an *existing* note (`openResolvedOnly`)
  but never creates one — the drawer body is not yet a document, and
  minting files from text that may be discarded would be surprising.

## Consequences

- Links survive renames only as well as names do: a moved/renamed target
  turns its inbound links unresolved (muted, dotted) rather than broken —
  Ctrl+click re-creates a fresh note. No link rewriting on rename (the
  task-center-style stable-id machinery is deliberately not pulled in for
  this).
- One more always-on editor extension on every Markdown surface; the pure
  parts (`extractWikilinks`, `wikilinkDecorations`, the completion source)
  are unit-tested like `link-open.ts`.
- `link-open.ts` and the conceal layer each gained a small
  "inside a wikilink span" guard (see ADR-0031's later change).

## Addendum (milestone 31) — media embeds `![[file]]`

Obsidian-migrated notes use `![[Pasted image ….png]]` for embedded images. The
wikilink grammar (note links by name) now additionally recognizes the
`!`-prefixed form when the target carries an image or PDF extension and
renders it through the same embed pipeline as `![](path)` — the shared
candidate chain (`shared/asset-refs.ts`) includes the `attachments/` folders,
so a bare name resolves even when the file sits beside the note or at the
vault root. Note targets (`[[note]]`, `![[Note#Heading]]`) still link, never
transclude; a `|alias` suffix on a media embed is alt text, or the display
size when it is a bare `W`/`WxH`. The PDF export rewrites media embeds to
standard image references before its markdown pass
(`shared/pdf-html.ts rewriteEmbedWikilinks`).
