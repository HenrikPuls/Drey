# 4. Solution Strategy

The handful of decisions everything else follows from. Each row names the
goal it serves ([§1.3](01_introduction_and_goals.md#13-quality-goals))
and the record of the trade-off.

| Goal | Strategy | Record |
|---|---|---|
| No lock-in | Plain Markdown with optional YAML frontmatter is the only source of truth. Indexes are caches that can be rebuilt from the files at any time. | `specs/frontmatter-schema.md` |
| No lock-in | The folder structure is the user's. Topics are inline `#tag` labels over a per-vault section index, never directories. | [ADR-0017](09_architecture_decisions/0017-tags-as-labels-and-section-index.md) |
| Text is never lost | Every write that replaces a note goes through one method (`VaultManager.writeFile`) and is atomic. A save carries the file time the tab last saw; if the file changed since, nothing is written and the user merges. What a write replaces is kept in a local history outside the vault. | [ADR-0060](09_architecture_decisions/0060-save-conflicts-and-local-note-history.md), [§8](08_crosscutting_concepts.md) |
| Text is never lost | A model never writes to a note directly. Its proposal is shown as a diff and applied only on confirmation. | [ADR-0011](09_architecture_decisions/0011-unified-confirmation-flow.md) |
| Private by default | The user interface is a sandboxed process with no file or network access. All of that lives in the main process behind a typed bridge. | [ADR-0001](09_architecture_decisions/0001-electron-process-split-contextbridge.md) |
| Private by default | Model access sits behind one interface with a provider per backend. The local endpoint is the default; hosted providers, CLI providers, web fetch and external tool servers are each off until switched on. | [ADR-0047](09_architecture_decisions/0047-llm-provider-abstraction.md), [ADR-0063](09_architecture_decisions/0063-mcp-client-and-assistant-tool-groups.md) |
| Writing is never blocked | No model call sits in the capture or save path. Generation has no timeout but can always be cancelled. | [ADR-0014](09_architecture_decisions/0014-no-chat-timeout-cancellable-tasks.md) |
| Writing is never blocked | No file watcher by default: the app refreshes after its own writes and on request. A watcher for changes by other programs is opt-in. | [ADR-0018](09_architecture_decisions/0018-manual-refresh-no-file-watcher.md), [ADR-0045](09_architecture_decisions/0045-optional-vault-file-watcher.md) |
| Features without touching the core | A small base application plus plugins loaded at startup. The base owns a set of registries (panels, tab kinds, commands, save hooks, search providers, …); a plugin fills them through a versioned interface and never imports base code. | [ADR-0044](09_architecture_decisions/0044-runtime-plugin-system.md), [§5](05_building_block_view.md) |
| Features without touching the core | Plugins are trusted and run in-process (the model Obsidian uses). This buys a simple, fast interface at the price of no isolation: a plugin can do whatever the app can. | [ADR-0044](09_architecture_decisions/0044-runtime-plugin-system.md) |

The app was built in milestones, each a working slice. The log is
[milestones-done.md](milestones-done.md) (1–27) and
[`specs/changelog.md`](../specs/changelog.md) (22 onward).
