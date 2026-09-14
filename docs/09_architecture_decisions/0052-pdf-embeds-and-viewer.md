# 0052 — PDF embeds and a PDF viewer tab

## Status

Accepted (milestone 30)

## Context

Req-2 asks for inline document rendering ("render Office documents
inline: Word, Excel, PowerPoint, PDF…; dragging a document directly
places it in the `attachments/` folder"). The PDF slice was pulled
forward because it is the one format Chromium can already render: a
dropped PDF today is *silently swallowed* by the drop cascade
(`image-paste.ts` — not an image, not on the text allowlist), and a PDF
already inside the vault opens as a mojibake **text buffer** whose
Ctrl+S would happily write the garbage back.

The Live Preview embed machinery is image-shaped: `scanEmbeds` renders
every `Image` node through `ImageWidget`, and `resolveImage` has no
extension gate, so a `![](x.pdf)` reference today would render a broken
`<img>`.

## Decision

**Chromium's built-in (PDFium) viewer, no bundled PDF library.**
`plugins: true` on the main window's `webPreferences` — on modern
Electron this flag enables *only* the PDF viewer — and the PDF renders
inside an `<iframe>` whose `src` is the existing
`drey-asset://<vaultId>/asset/<path>` URL (privileged scheme,
`supportFetchAPI`/`stream` since ADR-0024/0051). `pdfjs-dist` was
considered (themeable, self-drawn) and rejected: ~2–3 MB of bundle and a
hand-rolled viewer vs. one flag and a full-featured native viewer
(zoom, page navigation, find).

**One protocol hardening:** the asset handler pins
`Content-Type: application/pdf` for `.pdf` paths — the file:// loader's
MIME guessing inside `net.fetch` is registry-dependent on Windows, and
PDFium refuses a frame without the exact type. Images keep the sniffed
headers. Range requests ride the file:// loader's native byte-range
support, so large PDFs stream page-by-page rather than as one blob.

**Embed syntax is the image syntax.** A PDF embed is
`![name](attachments/x.pdf)` — same `Image` node, same note-relative
then vault-root candidate chain (`resolveVaultImageCandidates`). The
drop/paste cascade stages a PDF through the same
`attachments/`-beside-the-note rule, and the file keeps its
**original name** (`attachments/Quarterly Report.pdf`, collision gets a
`-2` suffix) — a deliberate deviation from ADR-0024's
timestamp+hash naming: PDFs are stand-alone documents the user browses
in the vault folder, not disposable paste artifacts. `saveAsset` gained
an optional `preferredName` (`sanitizedAssetFileName` strips
Windows-forbidden characters, enforces the extension, falls back to
`asset.pdf`).

**The embed is a Live Preview block widget.** `PdfWidget` (inline
replace decoration, like `ImageWidget`): a caption line (the alt
text = original file name), the viewer frame, and the shared
`</>` + lens chrome — `</>` reveals the raw `![…](…)` line in the
rounded container with a read-only `PdfPreviewWidget` mirror kept below
(exactly the Req-1 image affordances), the lens opens the file as a
**PDF tab**. Candidates are HEAD-probed before the frame mounts because
an `<iframe>` gives no usable error event for a 404 (the viewer paints
its own blank); all candidates dead → a compact `PDF not found:` box,
clickable back into the source. `|WxH` suffixes are parsed but
deliberately ignored — a page viewer's width is the column.

**A third base doc kind: `'pdf'`.** `EditorService.openFile` routes
`.pdf` to a `kind: 'pdf'` viewer doc (no buffer, never dirty — the same
contract as `'image'`), rendered by `PdfTab` over the PDFium frame. This
fixes the mojibake-text-buffer bug and makes plain
`[report](attachments/x.pdf)` links (already Ctrl-clickable) open the
tab. Session snapshot v2 carries `kind: 'pdf'` tabs like image tabs.

**Base, not a plugin (ADR-0044).** Three required seams are
base-internal: `openFile` routing decides the doc kind before any
registry lookup; the Live Preview block pipeline (`scanEmbeds`, reveal
layers, `atomicRanges`) would force a plugin into building a parallel,
conflicting decoration set over the same `Image` nodes; and the base
`ImageWidget` must stop claiming `.pdf` refs in the same branch that
gives them to the PDF widget. Same reasoning as wikilinks (ADR-0046).
The `DropDecoderContrib` seam stays plugin-shaped and untouched.

## Consequences

- Dropping a PDF into a note stages it into `attachments/` (name
  preserved) and inserts a read-where-you-are embed; the Files panel and
  in-note links open PDFs as viewer tabs; session restore reopens them.
- `webPreferences.plugins: true` is a deliberate window-level flag (its
  only effect on modern Electron is the PDF viewer) — recorded here so
  it is not "cleaned up" by accident.
- Keys pressed while the PDF frame has focus belong to the viewer, not
  the editor keymap; the fixed frame height (`--lp-pdf-height`, 480px
  default) bounds how much of the note one embed occupies. The frame is
  not sandboxed — the `src` is always a widget-constructed
  `drey-asset://` URL, and sandboxing breaks the built-in viewer.
- Per revealed embed a second frame mounts (the reveal mirror) — one
  extra viewer instance per revealed line, acceptable at note scale; a
  lazy-mount is the follow-up if it ever shows.
- Non-goals: `![[x.pdf]]` wikilink embeds (wikilinks resolve the
  note-name space), per-embed resize grips, a height suffix syntax,
  Ctrl+click on the embed (the lens and the Files panel cover it).
- The Office half of Req-2 (Word/Excel/PowerPoint) stays open — PDF is
  the only format the platform renders natively.
