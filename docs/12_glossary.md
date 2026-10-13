# 12. Glossary

Terms as this documentation and the code use them. Terms of the first
design that no longer exist (master document, primary tag, inbox,
capture popup, tag routing) were removed on 2026-10-13; they are
explained where they were retired,
[ADR-0017](09_architecture_decisions/0017-tags-as-labels-and-section-index.md)
and [ADR-0002](09_architecture_decisions/0002-quick-capture-opens-daily-note.md).

## The user's data

| Term | Meaning |
|---|---|
| Vault | A folder on disk holding notes. Drey reads and writes the files in it directly. Several can be registered. |
| Vault registry | The list of vaults Drey knows, stored in `<userData>/vault-config.json` — never inside a vault ([ADR-0051](09_architecture_decisions/0051-multi-vault-registry.md)). |
| Vault id | The stable identity of a registered vault. Minted at registration, survives the folder being moved. |
| Active vault | The vault that new content goes to by default: daily notes, quick capture, chats. |
| Note | A Markdown file in a vault, with optional YAML frontmatter. |
| Section | The part of a note from one heading to the next. The unit the tag index, search and semantic retrieval work on. |
| Tag | A `#label` written in a note's text. May be nested with `/` (`#project/frontend`). Never a folder. |
| `#task` | The reserved marker for a task line. A structural marker, not a tag. |
| Wikilink | `[[Note]]` or `[[Note#Heading]]` — a link to another note by name ([ADR-0046](09_architecture_decisions/0046-wikilinks.md)). |
| Daily note | One note per day under the daily-notes root (`daily/` by default), created from `templates/daily.md`. |
| Entry | A timestamped block in a note (`## HH:mm`), inserted from the `/` menu. |
| Chat note | An assistant conversation stored as a note under `chats/` ([ADR-0048](09_architecture_decisions/0048-chats-as-vault-notes.md)). |
| Draft | An untitled tab saved to the hidden `.drafts/` folder when the app closes. |
| Attachment | A non-Markdown file a note refers to, kept under `attachments/`. |
| Structural folders | The folders Drey itself creates: `templates/`, the daily-notes root, `chats/`, `.drafts/`. Everything else is the user's. |
| Note history | Earlier versions of a note, kept outside the vault under `<userData>/history/`. |

## The application

| Term | Meaning |
|---|---|
| Base application | Everything that is not a plugin: shell, editor, vault access, model transport, the plugin hosts. |
| Main process | The Node side of the app (`electron/`). The only part with file and network access. |
| Renderer | The window (`src/app/`). Sandboxed; reaches the main process through the bridge. |
| Bridge | `window.dreyApi`, the typed interface the preload script exposes to the renderer. Its shape is `shared/ipc-api.ts`. |
| Plugin | A feature loaded at startup from `plugins/<id>/`: a main half, a renderer half, a manifest. Trusted, in-process. |
| SDK | The versioned interface plugins are written against (`shared/plugin-api/`): `DreyPluginApi` for the renderer half, `MainPluginContext` for the main half. |
| Seam | One kind of thing a plugin can register: a panel, a tab kind, a command, a save hook, … |
| Registry | The base-owned list behind a seam. The base draws or calls whatever is registered. |
| Provider | An object one plugin registers so that the base or another plugin can query its data: section search (tags), semantic search (assistant), task query (tasks). |
| Save hook | A function a plugin registers to run after every note save, used to keep its index current. |
| Quarantine | The state of a plugin that failed to start: not loaded, reported, the app runs without it. |

## The window

| Term | Meaning |
|---|---|
| Dock | One of three regions (left, right, bottom) holding panels. |
| Panel | One tool in a dock: Files, Calendar, Search, Tasks, Assistant, … Called a *widget* in the code. |
| Pane | One editor area. The centre can be split into several; a dock can host one as its *editor band*. |
| Tab | One open document in a pane. |
| Doc kind | What a tab shows: a note, an image, a PDF, a help page, or a kind a plugin registered (browser, diagram). |
| Doc key | A tab's identity: `vaultId::path`. |
| Live Preview | The default editing mode: the note is shown rendered, and Markdown syntax appears only around the cursor ([ADR-0009](09_architecture_decisions/0009-live-preview-decorations.md)). |
| Quick capture | A global hotkey that brings Drey forward and opens today's daily note. |

## Models and tools

| Term | Meaning |
|---|---|
| Provider (model) | One way to reach a model: the local endpoint, a hosted API, or a command-line tool ([ADR-0047](09_architecture_decisions/0047-llm-provider-abstraction.md)). |
| Action | A user-defined prompt run on a note, by hand or on save, whose result is applied after confirmation. |
| Ask | A question to the assistant in its panel. |
| Vault chip | The assistant's switch that adds the most relevant note sections to a question. |
| Semantic retrieval | Finding sections by meaning, through embeddings computed in the app ([ADR-0055](09_architecture_decisions/0055-semantic-vault-retrieval.md)). |
| Tool group | A set of tools the assistant may call, with one switch: vault, tasks, templates, web fetch, each external server. |
| MCP | Model Context Protocol. Drey is both a server (other programs use the vault) and a client (the assistant uses external servers). |
| Confirmation dialog | The one dialog that shows a proposed change as a diff ([ADR-0011](09_architecture_decisions/0011-unified-confirmation-flow.md)). |
| Own-write ledger | The record of files Drey itself just wrote, so the watcher does not report them as outside changes. |
