# 12. Glossary

| Term | Meaning |
|---|---|
| Vault | A folder on disk holding all notes for the app; can live inside OneDrive. No client-server split — the app reads/writes files in it directly. |
| Vault registry | The list of vaults the app knows ([ADR-0051](09_architecture_decisions/0051-multi-vault-registry.md)), persisted in `<userData>/vault-config.json` v2 — never inside a vault. |
| Vault id | The stable identity of a registered vault: minted at registration (`v` + hex), never changes, survives folder moves. Carried by IPC payloads, doc keys, asset URLs and the watcher/ledger. |
| Active vault | The one registered vault that new content (daily notes, quick capture, chats, scratch Save-as) targets by default; switchable from the Files panel. |
| Doc key | A tab's identity string: `vaultId::vault-relative-path` (bare path for vault-less docs). Panes, tab drag, session snapshots and drag payloads key on it; IPC keeps speaking plain relative paths. |
| Master document | `type: master` file, one per tag — combines classifier context (`description`) and glossary content. Once a topic outgrows one file, it becomes the folder's index (`<folder>/_index.md`). |
| Notiz (note) | `type: notiz` file — an ordinary content file inside a topic folder, no `art`/`description`, not used as classifier context. |
| Primary tag | `tags[0]` in frontmatter — the one tag that determines a file's physical folder location. Other tags are pure search metadata. |
| `art` | What kind of thing a master document's tag represents: `thema` (topic), `person`, `team`, `projekt` (project), or `begriff` (term). |
| Tag-first capture | Typing a known `#tag` routes a note deterministically with no LLM call — the fast/common path. |
| Inbox | Review queue (`inbox.md`) for untagged captures, new-folder proposals, and untracked externally-created files. Schema-free by design. |
| `#important` | Marker on a History entry that keeps it in the master document's Summary regardless of age/recency window. |
| `#task` | Inline task syntax in any note body; a structural marker, never a tag. The Tasks panel writes checkbox state back by re-resolving the line at tick time (fresh content, text match) and skipping ambiguous duplicates rather than guessing. |
| Quick-capture | Global-hotkey popup window for fast text entry with inline `#tag` support, independent of whatever's currently open in the main window. |
| Batch tag suggestion | Prompt 2 (`specs/classifier-spec.md`) — LLM-suggested tags for untagged inbox entries, shown as clickable chips, run only when the inbox is opened (not live). |
