# 50. OCR via the connected vision LLM

## Status

Accepted (req-9, desktop half). A deliberate **deviation** from req-9's
original sketch (Apple Vision Framework / local Tesseract in an iPad
expansion stage): recognition runs through the **connected
vision-capable LLM** of the [ADR-0047](0047-llm-provider-abstraction.md)
provider abstraction. VLMs read handwriting far better than classical
OCR engines, no extra native dependency ships, and the transport
(attachments, capability descriptor, cancel) already existed. Builds on
[ADR-0011](0011-unified-confirmation-flow.md) (the confirmation rewrite),
[ADR-0014](0014-no-chat-timeout-cancellable-tasks.md) (no timeout, user
cancels) and [ADR-0044](0044-runtime-plugin-system.md) (the feature lives
in a runtime plugin).

## Context

The owner photographs handwritten notes — mostly small slips of paper,
but also whiteboards and printed pages — and embeds them as images in
vault notes. That content is invisible to tag search and every other
text index. Req-9 asked for OCR; the iPad-stage tooling ideas
predate the LLM provider work and are strictly worse for handwriting.

The desired interaction: right-click an image — an embedded one inside a
note, or an image opened as its own tab — and get the recognized text
where it is useful. Whether the row is usable depends on the active
provider's `LlmCapabilities.imageAttachments`, and the provider/model
can change at runtime from Settings. An earlier draft hid the row when
the capability was missing; that read as "the menu doesn't work" (and on
the image tab, whose only possible row it is, as "no menu at all"), so
the shipped behaviour is a **grayed-out row plus an empty-menu
suppression** (below).

## Decision

- **The feature is a runtime plugin, `plugins/ocr/`** — not base and not
  part of the assistant. It registers exactly one UI affordance (the
  context-menu row) and one backend method (`ocr`); disabling it in
  Settings → Panels & plugins removes the feature with no base impact.
  The row shows on every resolvable image — **enabled** when the LLM
  switch is on and the active provider can read images, **grayed out**
  otherwise (a missing prerequisite stays visible; a plugin that is not
  loaded contributes no row at all).
- **Base grows three surfaces, all feature-agnostic**:
  1. *Menu click context* — the editor context-menu seam's provider
     callback receives an `EditorContextMenuTarget` (`editor` with the
     pane doc path + the clicked line, or `image` with the image tab's
     path), built by the base from two DOM markers (`data-drey-doc` on
     the pane editor host, `data-drey-image` on the image tab). Surfaces
     that are not pane documents (entry drawer, plugin composers) carry
     no doc path, so document-scoped rows never fire there.
  2. *The image tab as a context-menu surface* — the renderer menu
     (ADR-0030) also opens on image tabs (clipboard rows suppressed
     there); right-clicking an image previously produced no menu at all.
  3. *A capability push* — every app-config write re-pushes the active
     provider's `LlmCapabilities` to the renderer
     (`llm:capabilities-changed`, new `AppConfigStore.onChange`
     observer), so plugins can keep a synchronously-readable cache for
     sync UI gating; the row flips enabled/disabled on a Settings save
     without a restart. Capability-gated, never provider-id-gated.
     Two menu-hygiene rules came with this: `ContextMenuItem` gained a
     `disabled` flag (a grayed, unclickable row — "this exists, but not
     right now"), and the menu **opens only when it would have at least
     one row** (an image tab has no built-in rows; a throwing plugin
     provider is skipped so it can never blank the menu).
- **The OCR call runs in the plugin's main entry** — the renderer-side
  LLM facade cannot carry image bytes across IPC. Main resolves the
  vault-relative path (`ctx.vault.resolveAssetPath`), reads the file
  (`node:fs`, base64), and calls `ctx.llm.chat` with `attachments` +
  the renderer-minted `taskId` (cancel via `api.llm.cancelTask`) and a
  generous `maxOutputTokens: 4096`. The image-target resolution from
  the click prefers the widget's `drey-asset://` `src` reverse map and
  falls back to a raw-`![…](…)`-line regex (source mode), vault paths
  only — `http(s)`/`data:` images get no row (v1).
- **Result routing by surface**: an embedded image's transcription is
  spliced **below the image line** (one blank line, plain Markdown, no
  callout) through the shared confirmation dialog
  (`documents.requestRewrite`, localized diff); confirming applies and
  saves. An image tab's transcription opens as an **unsaved scratch
  tab** `<image-basename>.md` (the tags export's `openScratch`
  pattern). While the run streams, a small modal shows the partial
  text, an elapsed hint and Cancel (ADR-0014); an error renders in the
  same modal.
- **The prompt is verbatim-transcription, in the plugin**: transcribe
  ALL visible text, preserve line breaks/lists, plain Markdown, no code
  fence (one outer fence is stripped tolerantly anyway), `[illegible]`
  for unreadable words, `[no text]` for an empty image. Documented in
  `specs/classifier-spec.md` ("Prompt 3").

## Consequences

- Handwritten content becomes searchable the moment its note is saved —
  the transcription is ordinary note text feeding the tags/section
  index.
- A provider *capability* is not a *model* property: the OpenAI-compat
  dialect reports `imageAttachments: true` unconditionally, so a
  non-vision LM Studio model still shows the row and the call fails
  with the provider's error, surfaced in the modal. There is no honest
  model-level probe (the model id is hand-enterable by design).
- The prompt lives in the plugin (v1: not user-editable, unlike the
  Autotag prompt in `shared/app-config.ts`).
- The transcription lands where the click was, not in a queue — no
  batch OCR, no folder watcher (v1 scope; req-9's "OCR drop field"
  idea stays parked).
- Dismissing the progress modal by backdrop does not cancel the run
  (`ui.showModal` exposes no close notification); the run finishes and
  its result still lands.
- The iPad / Apple-Vision remainder of req-9 stays open on the roadmap.
