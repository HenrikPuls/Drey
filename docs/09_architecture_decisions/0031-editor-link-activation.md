# 31. Ctrl/Cmd-click to open a link in the editor

## Status

Accepted. Builds on the Live Preview conceal layer
([ADR-0009](0009-live-preview-decorations.md)) and mirrors the `#tag` pill
`Ctrl`/`Cmd`-click ([ADR-0017](0017-tags-as-labels-and-section-index.md)).
The external-URL guard reuses the same allowlist as the window
navigation guard ([ADR-0027](0027-window-dnd-navigation-guard.md)).

## Context

Live Preview concealed a link's `](url)` target and left the label as
plain document text, with no way to follow it — clicking only placed the
caret. The project owner wanted a link click to open the link.

A plain click cannot open the link: the cursor lives in the rendered
document (ADR-0009), so a plain click on a link must still place the
caret there. The established modifier for "act on this span, don't edit
it" is already `Ctrl`/`Cmd`-click, used for `#tag` pills.

## Decision

- A new `linkActivation(onOpen)` CodeMirror extension (`src/app/editor/
  link-open.ts`), wired next to `tagPills` — **outside** the mode
  compartment, so links are also clickable in source mode.
- It marks the link span (`[label](url)`, `<autolink>`, bare GFM URL)
  with `class="cm-lp-link"` + `data-href`, adds `cursor: pointer`, and on
  a `Ctrl`/`Cmd`-`mousedown` calls `onOpen(href)` and swallows the event.
  An `Image`'s URL is deliberately not marked.
- `Editor.activateLink` classifies the target:
  - `http:` / `https:` / `mailto:` → `dreyApi.openExternal(url)` → a new
    `app:open-external` IPC handler that calls `shell.openExternal` **only**
    for those three schemes (a note must not be able to launch `file:`
    etc.);
  - any other explicit scheme → ignored;
  - otherwise `resolveVaultLinkPath` resolves it relative to the open
    note (dropping `#anchor` / `?query`, adding `.md` when there is no
    extension, rejecting a path that climbs above the vault root) and
    `EditorService.openFile` opens it as a tab.
- `resolveVaultLinkPath` reuses `normalizeRelative` from `vault-image.ts`.
  `[[wikilinks]]` are out of scope here (no Lezer node in the current
  config) — they arrived later as their own feature
  ([ADR-0046](0046-wikilinks.md)).

## Later change (req-20)

`[[wikilinks]]` landed as a separate base feature
([ADR-0046](0046-wikilinks.md)): regex mark decorations + a `Ctrl`/
`Cmd`-click handler in `src/app/editor/wikilinks/`, still without a Lezer
node. Where lezer-markdown parses the text between the brackets as a
shortcut-reference `Link`, both `linkTargetDecorations` and the conceal
layer now skip those spans — the wikilink plugin owns their styling and
activation.

## Consequences

- One more always-on editor extension; the pure `linkTargetDecorations`
  and `resolveVaultLinkPath` are unit-tested like the other conceal-layer
  pieces.
- `DreyApi` gains `openExternal`; `AppInfo` is untouched.
- Internal links only navigate to a file, not to a heading within it —
  acceptable for now, and consistent with the tag-search open-at-line
  being the only in-file positioning the app does. (Superseded by
  [ADR-0046](0046-wikilinks.md), whose `[[note#heading]]` jumps land on
  the heading's line.)
