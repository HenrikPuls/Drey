# 12. Glossary

| Term | Meaning |
|---|---|
| Vault | A folder on disk holding all notes for the app; can live inside OneDrive. No client-server split — the app reads/writes files in it directly. |
| Master document | `type: master` file, one per tag — combines classifier context (`description`) and glossary content. Once a topic outgrows one file, it becomes the folder's index (`<folder>/_index.md`). |
| Notiz (note) | `type: notiz` file — an ordinary content file inside a topic folder, no `art`/`description`, not used as classifier context. |
| Primary tag | `tags[0]` in frontmatter — the one tag that determines a file's physical folder location. Other tags are pure search metadata. |
| `art` | What kind of thing a master document's tag represents: `thema` (topic), `person`, `team`, `projekt` (project), or `begriff` (term). |
| Tag-first capture | Typing a known `#tag` routes a note deterministically with no LLM call — the fast/common path. |
| Inbox | Review queue (`inbox.md`) for untagged captures, new-folder proposals, and untracked externally-created files. Schema-free by design. |
| `#important` | Marker on a History entry that keeps it in the master document's Summary regardless of age/recency window. |
| `#task` | Inline task syntax in any note body; requires a stable `id:` (not line-number-based) so a future task center can write checkbox state back unambiguously. |
| Quick-capture | Global-hotkey popup window for fast text entry with inline `#tag` support, independent of whatever's currently open in the main window. |
| Batch tag suggestion | Prompt 2 (`specs/classifier-spec.md`) — LLM-suggested tags for untagged inbox entries, shown as clickable chips, run only when the inbox is opened (not live). |
