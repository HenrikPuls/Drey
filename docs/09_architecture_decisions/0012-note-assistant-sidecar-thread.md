# 12. The note assistant's thread lives in a sidecar file, not in the note

## Status

**Superseded** — the automatic-summary feature was removed entirely
(req: no LLM generation on open, no sidecar writes; existing
`.{name}.chat.json` files stay on disk but nothing reads or writes them).
Since [ADR-0048](0048-chats-as-vault-notes.md) conversations live in chat
notes under `chats/` (bug-10(b): the sidecar could not persist tool
calls/results). The sidecar storage format itself proved the right call
while the feature existed; the feature — a summary generated on first
open — is what the owner removed.

## Context

The assistant panel on the right shows, per note: an automatic summary of
that note, then the questions asked about it and the answers given. That
material has to survive closing the app — a summary the user paid an LLM
call for should not be regenerated on every open, and a thread that
vanishes on restart is not worth reading back.

So it needs somewhere to live. Three candidates:

1. **Inside the note**, as a `## Assistant` section or in frontmatter.
2. **In a central store** — one JSON/SQLite file per vault holding every
   note's thread.
3. **In a sidecar file** next to the note.

Option 1 fails on a rule the project has held from the start: the vault is
plain Markdown a human wrote, and nothing writes into a document the user
did not edit. An auto-summary firing on *open* would dirty a buffer, mark
a tab modified, and — via the on-save pipeline — potentially route text the
user never typed into a master document. It would also be visible in every
other Markdown editor the vault is opened with, which is exactly the kind
of proprietary residue `specs/frontmatter-schema.md` avoids.

Option 2 reintroduces a database as a second source of truth: a note moved
or renamed outside the app orphans its thread, and the file tree stops
being the whole story. The roadmap is explicit that a vault is just a
folder.

## Decision

One sidecar file per note, beside it, dot-prefixed:

```
daily/2026-09-26.md  ->  daily/.2026-09-26.chat.json
```

- The format, its defensive parser and the path derivation live in
  `shared/chat-thread.ts`, so both processes agree on them; `ChatStore`
  (main) does only the file IO, through `VaultManager` — the vault escape
  guard applies to sidecars as it does to notes.
- The dot prefix is doing real work: `VaultManager.listFiles` and
  `listMarkdownFiles` already skip dotfiles, so sidecars are invisible in
  the file tree and to the tag index **without a single new exclusion
  rule**.
- A thread is `{version, notePath, cards[]}`; a card is
  `{id, role: 'summary' | 'question' | 'answer', text, at}`. Parsing is
  defensive in the `normalizeAppConfig` style — a hand-edited or truncated
  file degrades to an empty thread, because the panel must still open.
- The **auto-summary rule** (`AssistantService`): a note opened for the
  first time this session, with no sidecar thread yet and the panel toggle
  on, gets a summary generated and stored as the thread's first card.
  Anything else does nothing.
- The panel's "Automatic summary" switch is **session state per
  note**, seeded from `assistant.autoSummaryDefault` in the app config. It
  overrides the default for that note only and never writes back — a
  one-off "not for this note" must not silently become the global rule.
  The default is changed in Settings → Assistant, and nowhere else.
- The summary prompt is the `note-summary` built-in action template, so it
  is editable in Settings → Actions like every other built-in and the
  wording is not duplicated in code. It is refused as a *generic* action
  (`ActionRunner.run` returns a noop for it): its result is a panel card,
  and running it as a document rewrite would replace the note with its own
  summary.

## Consequences

- Notes stay clean Markdown; nothing the assistant does can dirty a buffer
  or trip the save pipeline.
- Copying a note without its sidecar loses the thread, and renaming a note
  outside the app orphans the sidecar. Accepted: the thread is derived
  data, cheap to regenerate, and the alternative is a central index that
  goes stale in worse ways.
- Sidecars are invisible to the user in the app. If that becomes a
  surprise ("what are these dotfiles in OneDrive?"), a note in the docs is
  the fix, not a different location.
- A vault synced across machines syncs threads too, for free, as files.
- Not addressed here: pruning. A deleted note leaves its sidecar behind.
  Cheap to fix once a file watcher exists (see `docs/11`).
