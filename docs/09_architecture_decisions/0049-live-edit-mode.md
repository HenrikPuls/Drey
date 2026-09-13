# 49. Live edit mode — the assistant edits the open note directly

## Status

Accepted (Req-32). A per-turn, explicitly opt-in **exception** to
[ADR-0011](0011-unified-confirmation-flow.md)'s confirm-then-apply rule —
the confirmation dialog is not shown for a live-edit turn; the user chose
the mode deliberately, per turn. Builds on ADR-0047 (the provider
abstraction: tool loop, `toolTrace`, capabilities), ADR-0048 (the chat
note whose `edit` fence entries record what was applied) and ADR-0014
(the task id / cancel contract). Manual save stays (req-25): a live edit
lands in the buffer as an unsaved change — Ctrl+Z undoes it, Ctrl+S
saves it.

## Context

The assistant's only "LLM changes the document" paths so far return the
WHOLE revised document (Ask-mode `{"kind":"edit"}` replies and the
Actions engine) and always go through the ADR-0011 confirmation dialog.
For an editing conversation — "restructure this section", "turn these
paragraphs into tasks" — that is heavy: whole-document round trips, a
modal per turn, and the model cannot see the effect of its own change
before the next instruction.

The owner asked for a Cursor/Claude-Code-style **live edit mode**: a
toggle in the assistant composer; while on, the model edits the open
note directly and immediately, with no per-change dialog. Two
refinements: while the model works, the user's input on that document is
blocked (advisory lock + a meta-bar hint), and the model edits via
**diff hunks** (search/replace pairs) instead of rewriting large
documents wholesale.

## Decision

- **One toggle, per turn, session-scoped**: a "Live edit" chip pinned
  first in the composer's chips row (pencil icon, accent when on). It
  refuses to switch on without an open note and on app-owned auto-save
  paths (`chats/`, `.drafts/` — the engine must never live-edit its own
  chat notes). Excluding the note chip turns it off; turning it on
  re-includes the note. The ask payload carries `liveEdit: boolean`,
  clamped renderer-side so only a live-editable note can send `true`.
- **Tool-based multi-edit** (ADR-0047's loop, generalized): the SDK's
  `MainChatOptions` gains a passthrough `tools` / `onToolCall` /
  `maxToolRounds`; the plugin-host facade merges the plugin's tools with
  the vault tool set (plugin names win collisions; dispatch by name).
  PLUGIN_API_VERSION minor 3 → 4. The renderer-side `drey.llm.chat`
  reserved method deliberately does NOT grow this surface — callbacks
  cannot cross the IPC boundary; the loop runs main-side.
- **The doc tools** (`plugins/assistant/main/live-edit.ts`, pure, never
  throws — errors return as text the model can react to):
  `doc_apply_diff` (one or more `{find, replace}` hunks applied
  atomically and in order — every `find` must match the evolving copy
  exactly once, else nothing is applied and the error names the failing
  hunk), `doc_write` (whole-document replacement, full restructures
  only), `doc_read` (1-based numbered window, 400-line cap). The system
  prompt replaces the JSON protocol: edit via the tools, then answer
  with a short plain-text summary.
- **A main-side working copy**: the session seeds from the note's live
  buffer at send time and applies each hunk to `work`; after every
  mutating call the engine pushes the whole working copy through its own
  `chat:liveEdit` plugin event, and the renderer applies it with
  `documents.setBuffer` — one CodeMirror transaction per push, so each
  mutating tool call is ONE Ctrl+Z step and the caret stays put.
  Main-side ownership keeps the model's view (`doc_read`) consistent
  mid-turn even if a push races a repaint; the next turn re-reads the
  live buffer, so user changes between turns are always seen.
- **The advisory lock**: while a live turn runs, the state factory locks
  the target through `documents.setEditLock(path, true)` and releases it
  in the ask's `finally` (success, error and cancel alike). The base
  implements the lock as an `EditorView.editable` compartment — NOT
  `EditorState.readOnly`, which would filter the model's own buffer
  pushes — plus a muted "Assistant is editing…" hint in the meta bar.
  Undo/side effects still dispatch; this is UX protection, not a hard
  invariant.
- **Persistence and replay unchanged** (ADR-0048): a live turn appends
  its assistant turn with the tool trace, and — when anything was
  applied — the full applied document as the turn's `edit` fence entry
  (`applied: true, after`). The next replay shows the model its own
  result. No `EDIT_PROPOSAL_MARKER`, no `chat:appendEdit` round trip.
- **Providers without tool support fail visibly**: the engine checks
  `capabilities().tools` BEFORE anything is persisted and throws a
  visible error (the CLI providers declare `tools: false`).

## Consequences

- ADR-0011 is bypassed only for this explicitly opted-in turn; every
  other edit surface (Actions, Ask replies, MCP `vault_write`, on-save
  hooks) keeps the confirmation. The vault tools inside a live turn stay
  confirm-gated too — live edit never weakens `vault_write`'s gate.
- User keystrokes typed before the lock lands or between pushes can be
  overwritten by the next push (last-writer-wins per push, one undo step
  each); they heal at the next turn (the buffer is re-read at send).
- Cancel or failure mid-turn leaves the applied edits in place with a
  truncated chat turn — the document is the working state, Ctrl+Z walks
  it back; the chat note simply ends before the assistant turn.
- Closing the target tab mid-turn makes `setBuffer` no-op; those edits
  survive only in the chat note's `edit` entry.
- A non-live follow-up replays the doc-tool history without offering
  those tools (same tolerance as vault-tool turns in answer-only asks
  today); `editCatchUpLine`'s "proposed … applied by the user" wording
  never matches a live edit (unreachable: it fires on `sessions`
  providers only, and the only one has `tools: false`).
- The round cap (16) can hit mid-edit; the providers then deliver an
  empty text, and the outcome falls back to "Applied N edit(s) …".
- An `askOnSave` scratch tab passes the path guard and can be live-edited
  in the buffer; its replay-side `doc_read` degrades to a warning line
  (the path is not in the vault).
