# 59. Link integrity on rename / move — a base-owned rewrite, attachments travel with their note

## Status

Accepted (milestone 59). Builds on ADR-0046 (wikilinks and their
resolution), ADR-0051 (vault-scoped links, cross-vault moves) and the
milestone-53 replace discipline (fresh read at apply time, CRLF kept).
Amends ADR-0046: grammar and resolver now live in `shared/wikilinks.ts`.

## Context

Renaming or moving a note in the Files panel was a bare `fsp.rename`:
every `[[wikilink]]` to the note went dangling, and a note moved to
another folder lost the images it embeds relative to itself
(`![](attachments/x.png)`). In a link-based vault that makes
reorganising notes something to avoid.

Three questions had real alternatives:

1. **Who owns the rewrite** — the backlinks plugin (it already indexes
   outlinks) or the base.
2. **Whether to ask** before touching other notes.
3. **What happens to attachments** of a note that changes folder.

## Decision

**1 · The base owns it; no standing index.** Renaming is a base
operation, and link integrity must not depend on an optional plugin
being enabled. The backlinks index would not have saved the work anyway:
the rewrite has to read every affected file fresh at apply time. So a
rename runs one scan of the source vault's notes:

- `shared/wikilinks.ts` — the wikilink grammar and the Obsidian-style
  resolver, moved out of the renderer so renderer and main share one
  definition (`WikilinkService` and the editor decorations import it; the
  backlinks plugin keeps its parity-tested twin, as plugins cannot import
  base modules).
- `shared/link-rewrite.ts` — the pure planner, `planRename`.
- `electron/link-rewriter.ts` — reads the vault, calls the planner,
  renames, writes.

**2 · The rule is "before vs. after", not "search and replace".** For
every reference in every note: what did it open before the rename, and
does the unchanged text still open that afterwards? Only a reference
whose answer changes is rewritten. One rule covers a renamed note
(`[[Old]]` → `[[New]]`, anchor / alias / embed `!` kept), a moved note
(`[[Note]]` stays while the name is unique; `[[folder/Note]]` follows), a
renamed or moved folder, a renamed attachment, and an ambiguity that
shifts because the *linking* note moved. The new text keeps the
original's style: bare name while it still resolves, else the
extension-less path, else the full path. Frontmatter, fenced blocks and
inline code are never touched.

**3 · Attachments travel with their note.** When a note changes folder,
a non-note file it references *relative to itself* and that nothing
outside the move references moves along to the same offset under the new
folder — the link text stays as written, and an emptied `attachments/`
folder is removed. A file other notes use too stays put; the moved
note's reference is rewritten to a relative path instead. Nothing is
ever overwritten: an occupied destination falls back to the rewrite.
Covered reference forms: `![alt](url)`, `[text](url)`, `![[file]]`,
`<img src>`, resolved through the existing `shared/asset-refs.ts` chain.

**4 · Across vaults** wikilinks are vault-scoped (ADR-0051), so there is
nothing to rewrite to. Attachments still follow: an exclusive one moves
into the target vault, a shared one is copied.

**5 · Ask, with a standing answer.** `vault.updateLinksOnRename`
(Settings → Vault): `ask` (default) shows the affected notes — per note,
the changed lines before / after — plus the attachments that travel, and
offers *Update links* / *Rename only* / *Cancel*; "Don't ask again"
turns the answer into `always` or `never`. A rename that affects nothing
shows no dialog. The dialog is its own component (`LinkUpdateDialog`):
ADR-0011's confirmation is a two-way single-document diff, this is a
three-way multi-file one.

**6 · Open tabs.** Dirty open notes are sent along as buffers, planned
against the buffer, and come back patched instead of being written — a
disk write would be undone by the tab's next save. Clean tabs are
re-read after their keys follow the rename.

## Consequences

- Reorganising a vault no longer breaks links or orphans images.
- Every rename with the mode on `ask`/`always` reads all notes of the
  vault once (the tag rename does the same). `never` skips the scan.
- No undo beyond renaming back, which rewrites in reverse; moved
  attachments stay where they went. Local snapshots are the next
  milestone.
- Not covered: renames made outside the app; wikilinks into a note that
  moved to another vault; `[[note#heading]]` anchors when a heading is
  renamed.
- Two wikilink grammars remain by design (shared + the backlinks twin,
  guarded by the plugin's parity spec).

## Considered and rejected

- **Rewrite inside the backlinks plugin behind a new "before rename" SDK
  hook** — couples a correctness property to a plugin switch and adds an
  SDK surface for one caller.
- **Always rewrite silently (Obsidian's default)** — without snapshots
  there is no net yet; the dialog's "Don't ask again" gets there in one
  click for whoever wants it.
- **Rewrite attachment links instead of moving the file** — leaves
  images scattered in the folders their notes left. Most images belong
  to exactly one note, so moving is the natural default.

## Later change — the safety net exists (milestone 60)

"No undo beyond renaming back" is softened by
[ADR-0060](0060-save-conflicts-and-local-note-history.md): every note a
link update rewrites has its previous text in the local history (origin
`links`), and the history follows the renamed note. Moved attachments
are still not versioned.
