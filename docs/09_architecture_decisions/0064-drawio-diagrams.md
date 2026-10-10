# 64. draw.io diagrams: a plugin embeds the bundled editor; the diagram file is a picture

## Status

Accepted (milestone 64, req-19). Adds one extension point to ADR-0044
(a plugin can open files by name suffix) and a third plugin tab kind
next to the browser tab. Complements ADR-0052 (PDF) and ADR-0025
(Mermaid) as the third way a note shows something that is not text.

## Context

req-19 asks for draw.io diagrams that can be viewed and edited in Drey.
Before this milestone a `.drawio` file opened as raw XML in the text
editor, and there was no way to create a diagram from a note.

Four questions had real alternatives: where the editor comes from, what
the file on disk is, where the feature lives, and how a diagram is
saved.

## Decision

**1 · The draw.io web app ships with Drey and runs offline in an iframe.**
The editor is draw.io's own web app, loaded from
`plugin://drawio/webapp/index.html` in embed mode
(`embed=1&proto=json&offline=1&stealth=1`) and driven over its JSON
`postMessage` protocol. No request leaves the machine.

draw.io is not an npm package, and about 2800 files do not belong in
git. `scripts/fetch-drawio.mjs` downloads the release archive pinned in
`plugins/drawio/drawio-version.json` (version + SHA-256), verifies it,
and unpacks it into `plugins/drawio/vendor/webapp/` (gitignored) with a
dependency-free zip reader. It leaves out what the offline embed never
loads: server classes, the service worker, the cloud storage connectors,
the stand-alone viewer builds and the unminified sources — 118 MB become
55 MB. `build-plugins.mjs` copies `vendor/` next to the built plugin;
`npm run pack` fetches first. A build without the web app still works:
the diagram tab says the editor is not part of this build.

Rejected: **`embed.diagrams.net` online** — no size cost and always
current, but no editing without a network and one more exception to "no
cloud calls". **View only, edit in draw.io Desktop** — the smallest
change, but then Drey does not edit diagrams at all.

**2 · The diagram file is a picture that carries the diagram.**
New diagrams are `.drawio.svg` or `.drawio.png`: an ordinary SVG or PNG
with the diagram XML inside (the SVG's root `content` attribute; a PNG
`tEXt` chunk named `mxfile`). To every other part of Drey — Live
Preview, the image tab, the PDF export — and to GitHub, Obsidian or a
browser, the file is just an image. Embedding a diagram in a note is
therefore the existing image embed (`![diagram](attachments/x.drawio.svg)`)
and needed no new renderer; the PDF-export parity rule is met by
construction.

Which of the two a new diagram gets is a setting (Settings → Diagrams,
stored in the plugin's own config): **SVG** by default — sharp at every
size, and text — or **PNG** for programs that cannot show SVG. Existing
files keep their format. A plain **`.drawio`** XML file opens and is
edited too, but it is not a picture and cannot be embedded.

Rejected: plain `.drawio` as the embed format — it would need a viewer
widget in Live Preview and a second one in the PDF export.

**3 · A plugin, plus one new seam (SDK 1.16).**
`plugins/drawio/` is renderer-only: a doc kind `drawio` whose tab key is
`drawio://<vaultId>/<path>`. The heavy web app lives inside the plugin
and disappears from a build without it; disabling the plugin returns
`.drawio.svg` / `.drawio.png` to the image tab and `.drawio` to the text
editor.

ADR-0052 kept PDF in the base because `openFile` decides the tab kind
before any registry is asked. This milestone adds that registry instead:
`documents.registerFileOpener({ extensions, open })`. `EditorService.openFile`
consults `FileOpenerRegistry` first; the longest matching suffix wins,
so `.drawio.svg` beats the base's own `.svg`. An opener that throws
falls back to the base routing. The Office formats (Req-2) can use the
same seam.

A new diagram can be started four ways, all the same flow (create the
file in `attachments/` beside the note, embed it, open the tab — in that
order, because the tab may take the note editor's place): the editor
context menu, `/diagram` in the slash menu (a completion source the
plugin adds to the "Formatting" section), an icon button in the
formatting bar, and File → New diagram (no embed). The formatting bar
was base-only; `editor.registerToolbarButtons` (SDK 1.16,
`ToolbarContributionsService`) lets a plugin append icon buttons, so the
base does not have to know the plugin.

The plugin needed three more things from the SDK, all added in 1.16:
`vault.readBinary` / `vault.writeBinary` (a PNG saved in place —
`saveAsset` picks its own name) and `announce` on the two writes.
A plain `vault.writeFile` told only the main-side plugins; with
`announce` the write runs the ordinary change round for its path, so the
file tree shows a new diagram and the renderer hears about it.

**4 · Saving is automatic.**
A plugin tab has no dirty state, and adding one would be a second,
larger seam (tab marker, exit prompt, Save routing). So a diagram tab
saves itself, like chat notes: about one second after the last change,
and when the tab closes.

`EmbedSession` (pure; frame, file and clock are ports) holds the rule.
A `.drawio` is written from the XML the editor reports. A picture format
needs the editor to render the picture, and a closed tab has no editor
any more — so every change asks for an export at once (one in flight at
a time) and only the *write* is debounced. If the tab closes while an
export is still out, the last picture is written with the newest diagram
XML put into it: the model is never lost, the pixels catch up on the
next edit.

**5 · Pictures follow the file.**
An `<img>` never refetches an unchanged URL, so a diagram saved in its
tab would stay stale in every open note. On a `vault:changed` push with
paths, `refreshChangedAssets` bumps a per-path revision: `drey-asset://`
URLs for that path carry `?v=<n>` from then on (the serving handler
ignores the query), and pictures already on screen get the new URL. This
is base behaviour and also fixes an image edited outside Drey while the
watcher is on.

## Consequences

- The installer grows by the web app: about 55 MB unpacked.
- Updating draw.io is manual: change the pin, fetch, re-check the embed
  protocol (`embed-session.ts`) and the trim list (the e2e test fails on
  a request the trimmed copy cannot answer).
- draw.io is Apache 2.0, compatible with Drey's GPL-3.0; the licence
  text ships as `webapp/LICENSE` and the editor is listed in About.
  "draw.io" is a trademark: the plugin is named **Diagrams** and uses
  neither name nor logo as its own.
- While the editor frame has focus, keys belong to draw.io, not to
  Drey's keymap — the same rule as the PDF tab.
- A diagram that was never drawn is a **placeholder picture** (240 × 120,
  a dashed frame with "Empty diagram"), not an empty one: a blank
  diagram has no extent, and the first build wrote a 1 px picture that
  was invisible in a note. The editor's first save replaces it. For PNG
  the placeholder is drawn on a canvas and the diagram chunk put in.
- Base Live Preview: an image rendered smaller than 9 px gets a box with
  room for its hover buttons (`lp-image-tiny`), so such a picture stays
  reachable. "Edit diagram" also works from the embed's source line, not
  only from the picture.
- Not done: a dirty state / manual save for plugin tabs; "Open in new
  tab" pinning a plugin-opened tab; converting between the formats;
  embedding a plain `.drawio`; a "New diagram" row in the Files panel's
  context menu (there is no plugin seam for that menu); local history
  for diagrams (ADR-0060 covers notes); following a rename of an open
  diagram (the tab shows "Diagram not found").
- The assistant cannot read or draw diagrams.
