# 48. Chats as vault notes — conversations under `chats/`

## Status

Accepted (req-30, resolves bug-10(b)). Supersedes
[ADR-0012](0012-note-assistant-sidecar-thread.md) **for conversations**
(the sidecar stays for the automatic note summary). Builds on ADR-0044
(the assistant is a plugin), ADR-0047 (the provider abstraction whose
`toolTrace` / `sessionRef` / capabilities this rides) and ADR-0045 (the
announce round reused for chat-note writes).

## Context

Ask conversations persisted as per-note sidecar files
(`.{name}.chat.json`): only the answer *text* was stored — tool
calls/results and applied-edit content were dropped, so follow-ups lost
that context, and history was capped at ~12 messages to keep the hidden
payload small. That is bug-10(b), and it is structural: a JSON sidecar
holding cards cannot carry a faithful conversation.

The owner's resolution: conversations become **standalone first-class
Markdown notes** — visible, editable, searchable with every other note —
persisted with full fidelity and replayed in full.

## Decision

- **Chat notes**: `chats/<yyyy>/<mm>/<yyyy-mm-dd>-<slug>.md` (nesting
  mirrors `daily/`; slug from the first question). Frontmatter carries
  `kind: chat` — the first new app-understood frontmatter field since
  ADR-0017, written as a plain scalar — plus plugin-read fields
  `provider`, `model` and (claude-code only) `session`. Everything else in
  the fence stays the user's; the plugin patches only its own fields.
- **Body grammar** (`plugins/assistant/shared/chat-note.ts`, defensive
  parse, never throws): one `## User` / `## Assistant` heading per turn
  (ISO timestamp after an en dash), an optional `<!-- drey: {json} -->`
  meta line (`durationMs`, `model`), and a ```drey-tool fence holding one
  JSON object per line: `{"call":…}`, `{"result":…}` or
  `{"edit":{path, applied, after?}}`. An applied edit persists the **full
  applied document** (`after`); a discarded one records only the marker.
  A user turn may end in a **link-only attachment block** (`[[note]]`,
  `![alt](path)`) — the paths are persisted, the bodies are not.
- **Replay** (`shared/chat-replay.ts`, pure): a follow-up sends the FULL
  persisted history — tool entries replay as real
  `assistant(tool_calls)` / `tool` message pairs, an applied edit replays
  as `[Applied change to <path>]` + the document, a discarded one as a
  plain marker. Attachment bodies are re-read from the vault at send
  time (missing → an inline warning line, never a failure). Images from
  past turns degrade to path mentions. The ~12-message cap is gone —
  the note is the context.
- **Provider-side sessions** (ADR-0047 capability `sessions`): claude-code
  resumes with `--resume` instead of replaying — but only while
  `frontmatter.session` is set, the provider is unchanged and the
  capability is there; otherwise (provider switched, stale session dir)
  the chat full-replays, with one full-replay retry when a resumed
  session has gone stale. A resumed session never saw a confirm result,
  so a catch-up line ("the change you proposed was applied/discarded")
  prefixes the next turn. Truncating the note ("restart from here")
  clears `session:`.
- **Chat-first panel**: chat picker + new chat in the head; turn cards
  with collapsible tool chips; a streaming partial answer (the plugin
  forwards its provider's `onDelta` through its own `chat:delta` event —
  the base `llm:delta` push fires only for renderer-initiated chats).
  Zero-context asks are legitimate (a standalone chat with nothing
  attached). Chat notes are normal `.md` and open as ordinary editor
  tabs; no custom doc-kind renderer.
- **Auto-saved, prompt-free** (`shared/structural-folders.ts`): the chat
  engine persists every turn itself, so the tab is a VIEW of the note —
  an append reloads it **even when the tab is dirty**, and a hand edit
  in the tab persists itself after a short idle (`isAutoSavePath`,
  shared with `.drafts/`). Consequently chats never trip the exit
  prompt, never refuse an ask, and only the user's own notes are ever
  "dirty" in the bug-5 sense; at exit, dirty temp files (scratch tabs,
  drafts) are committed silently instead of being asked about. The
  loss window is typing inside the auto-save delay (<1 s) when a turn
  lands — sub-second, and the conversation always wins over it.
  (Later change, same milestone: replaced the original
  "asking while the chat tab is dirty is refused" guard.)
- **Writes are announced**: the engine appends through a new
  `ctx.vault.writeAnnounced` facade — write, then the same
  external-change round an MCP write runs (index events + one scoped
  `vault:changed` push), so the Files tree, the tag index and open tabs
  see the note immediately. With the watcher off, nothing else would
  fire, and the watcher suppresses the app's own echoes anyway.
  `chats/` is indexed like `daily/` (only `templates/` is excluded), so
  `vault_search` finds conversations.
- **Images** (ADR-0047 capability `imageAttachments`): pasted/dropped
  images are staged through the new `api.vault.saveAsset` facade into
  `attachments/` beside the reference note (the ADR-0024 convention) and
  attach as chips; the current turn sends them as vision content parts,
  the note stores the path. Providers without the capability just get
  the path mention.
- **Sidecar import**: a one-shot, non-destructive "import into a chat
  note" action converts a note's sidecar Q/A cards into the turns of a
  new chat note; the sidecar file stays (it still holds the summary). No
  auto-migration.

## Consequences

- bug-10(b) is closed structurally: the conversation is the file, and
  everything the model said or did survives in it. bug-10(a)'s interim
  `history` validation is gone with the `history` payload field itself.
- **Unbounded replay** on non-session providers: a long chat note sends
  its whole history every turn and can overflow a local model's context
  window. Accepted for now (the cap's removal is the point); a future
  cap knob would be a policy in the replay builder, not a format change.
- **Note size**: applied documents are stored in full inside the chat
  note — deliberate (fidelity over compactness), and the note is the
  user's to trim.
- A question whose line literally starts with `## User` inside its text
  parses as a turn boundary (documented grammar edge; no data is lost —
  the text just becomes two turns).
- Parse edges are tolerated everywhere (hand-edited fences, `--` instead
  of the en dash, CRLF), but a heavily hand-edited chat note is replayed
  as it now reads — by design.
- New plugin-SDK surfaces, all additive (`PLUGIN_API_VERSION` minor → 2):
  `ctx.vault.writeAnnounced`, `ctx.llm.capabilities`,
  `MainChatOptions.attachments`, renderer `api.llm.capabilities()`,
  `api.vault.saveAsset`, `LlmChatResult.toolTrace`.

## Later change — external files as context, prompt-free modals

- **Files not yet in the vault** can be attached directly: the `+` picker
  grew an "Add a file from this computer …" row (native multi-select
  dialog) and the composer's paste/drop now routes by extension, not just
  images. Everything is staged into the vault first — images hash-named
  via `saveAsset`, text files copied name-preserving and uniqued
  (`report-2.md`) under `attachments/` beside the reference note (the
  active chat, else the open note, else `chats/`) — so the chat note's
  attachment links resolve and replays re-read them exactly like
  vault-native attachments (paths-not-bodies holds). Staging rules in
  `plugins/assistant/shared/stage.ts`; the dialog + fs work in the
  plugin main's `chat:attachExternal`. `ctx.vault.saveAsset` joined the
  SDK (minor → 3, the main-side twin of the renderer facade).
- The host's plugin-modal backdrop **dismisses only when the press lands
  on the backdrop itself** — the modal box is the backdrop's child, and
  the old unconditional `mousedown` teardown fired for presses anywhere
  inside the modal (labels, padding, row gaps), tearing the overlay down
  mid-press and swallowing the subsequent `click` (removed-subtree
  suppression), which read as "clicks pass through the modal".

## Later change — chats bound to the active document

- **`note:` frontmatter** (a doc key `vaultId::relativePath`, quoted)
  records which document a chat belongs to; absent for an unbound chat.
  `ChatStore.create` writes it from the ask request's `noteKey` — the
  focused document at send time, regardless of whether the note chip rides
  along (the binding is the workspace the chat was started in, not a
  per-turn context choice).
- **The panel follows the active document**: a tab switch looks up the
  newest chat bound to that doc key and opens it; a document with no chat
  (or a non-note focus) resets the panel to a fresh chat. Generation runs
  are not interrupted, and a stale in-flight follow never lands. Manual
  chat picks (picker, "+ New chat") stay — honoured until the next
  document switch. Old unbound chats remain listable and openable.
- **Prompt picker instead of the summary**: with the ADR-0012 summary
  removed, the composer's meta row gained a "Prompts" picker over
  `templates/prompts/*.md` (owner format: `# Titel`, `> Beschreibung`,
  prompt body; missing description = `""`, missing title = file name).
  Picking replaces the composer's text — the user reviews and sends it as
  a normal question; no placeholder substitution.
