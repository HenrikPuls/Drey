# 11. One confirmation flow for Actions and Ask-mode edits

## Status

Accepted — implemented with the Actions system and the chat Ask/Input
toggle.

## Context

Two features landed at once that both need a "here is a proposed change to
your document — apply it?" step:

1. **Actions** — a trigger (on save / manual button) runs a prompt
   template against the active document and produces a rewrite.
2. **Chat Ask mode** — the bottom bar, in Ask mode, sends the document
   plus the user's instruction to the LLM; a document-modifying
   instruction comes back as a rewrite.

Building two confirmation dialogs — one per feature — would mean two
previews to keep consistent, two "don't ask again" stories, two sets of
apply plumbing. The requirement was explicitly one mechanism.

There is also a preview problem. A rewrite can be either:

- **small and localized** — check off one task, merge two frontmatter
  tags. A line-level diff of just the affected lines is the right view.
- **a whole-document rewrite** — reformat, or a user template that
  rephrases the whole note. A line diff of two differently-worded
  paragraphs is noise; before/after side by side is readable.

## Decision

### One `ConfirmationService` + one `ConfirmationDialog`

`ConfirmationService.request(req)` shows the dialog and returns a
`Promise<boolean>`. Every caller — `ActionsService` (manual actions and
the drained on-save queue) and `ChatService.ask` — goes through it.
_(Update, Feature A: `ChatService` is gone; that caller is now
`AssistantService.ask` in the note assistant panel. The mechanism below is
unchanged — see [ADR-0012](0012-note-assistant-sidecar-thread.md).)_
Requests are handled one at a time; a caller with several (the on-save
queue) awaits them in a loop.

`ConfirmationRequest` carries `previewStyle: 'localized' | 'document'`,
the `before`/`after` text, a `title`/`summary`, and `triggerId`
(`null` for an ad-hoc Ask edit).

### `previewStyle` is decided per template, or heuristically for Ask

- An action **template** declares `resultKind` (`localized` /
  `document`). User templates pick one in Settings. The current built-ins
  are not document rewrites confirmed through this flow: _Summarise note_
  and _Summarise search results_ produce panel/scratch text, _Autotag_
  only pre-fills the drawer's tag field.
- An **Ask** edit has no template, so `pickPreviewStyle(before, after)`
  in `shared/text-diff.ts` chooses: `document` when the change rewrites
  more than ~35% of the original lines or the length changes sharply,
  otherwise `localized`.

The localized view is `lineDiff` (an LCS walk, `shared/text-diff.ts`)
with runs of unchanged context longer than a few lines collapsed. The
document view is two `<pre>` panes.

### "Don't ask again for this action" is the same state as Settings

The dialog's checkbox is shown only when `triggerId` is set. Ticking it
and confirming calls `SettingsService.setTriggerConfirm(triggerId,
false)` — the identical toggle the Actions settings pane shows. One piece
of state, reachable from both places; no separate "suppressed dialogs"
list.

### Applying a confirmed rewrite cannot recurse

`EditorService.applyRewrite(path, after)` pushes the text into the tab and
saves with `runOnSaveActions: false` on the `note:save` request, so
applying one action's result never fires the on-save triggers again.

## Consequences

- `note:save` gained `NoteSaveResult.pendingActions` — the `'edit'`
  outcomes from on-save triggers that still need confirmation.
  Non-confirm on-save triggers are applied in the main process before the
  result returns (`content` already reflects them).
- `EditorService` exposes `pendingActions` as a signal and
  `ActionsService` drains it via an `effect`, so `EditorService` needn't
  depend on `ActionsService` (that would be a DI cycle).
- The main-process runner (`electron/action-runner.ts`) also hosts chat
  Ask, since answer-vs-edit routing and the LLM call are shared.
- Decision logic — `resolveActions`, `lineDiff`, `pickPreviewStyle` — is
  pure `shared/` code with Vitest coverage; the runner only sequences
  LLM calls. _(Update: `mergeFrontmatterTags` / `applySummarySection` /
  `selectSummaryInput` were removed with
  [ADR-0017](0017-tags-as-labels-and-section-index.md) — no `#tag`
  frontmatter merge and no master-document Summary any more.)_
- Autotag ships as a built-in template with a **manual** trigger, not
  on-save (`specs/classifier-spec.md`). `on-save` is a supported trigger
  type with no built-in mapping.
- _(Update: the "Update summary" master-document Action referenced here
  is gone — [ADR-0017](0017-tags-as-labels-and-section-index.md) removed
  master documents. The surviving summariser is the note assistant's
  per-note "Summarise note", [ADR-0012](0012-note-assistant-sidecar-thread.md).)_
