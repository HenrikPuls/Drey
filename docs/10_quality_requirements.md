# 10. Quality Requirements

The five quality goals of
[§1.3](01_introduction_and_goals.md#13-quality-goals) as scenarios: a
situation, what Drey does, and the mechanism that makes it so. A change
that would break one of these needs a decision, not just a review.

## 10.1 The user's text is never lost

| Situation | What happens | Mechanism |
|---|---|---|
| The machine loses power while a note is being saved. | The file on disk is the old version or the new one, complete. | Atomic replace in `electron/safe-file.ts` ([§8](08_crosscutting_concepts.md#crash-safe-file-writes)). |
| A note is changed by another program while it is open with unsaved edits, and the user saves. | Nothing is written. A merge view shows the disk version, the user's version and the result. | `note:save` carries the file time the tab last saw ([ADR-0060](09_architecture_decisions/0060-save-conflicts-and-local-note-history.md)). |
| A save, an assistant edit or a rename overwrites text the user wanted. | The replaced version can be restored from "File history…". | `VaultManager.writeFile` records what each write replaces under `<userData>/history/`. |
| The user quits with unsaved tabs. | Drey asks. Untitled tabs are kept as drafts and come back on the next start. | The exit bridge; `.drafts/`; session backups ([ADR-0043](09_architecture_decisions/0043-session-history.md)). |
| The settings file is cut off or not valid JSON. | It is set aside under a dated name, Drey starts on defaults and names the kept copy. | `readJsonObjectGuarded`. |
| A model proposes a change to a note. | The user sees a diff and confirms before anything is written. | The one confirmation dialog ([ADR-0011](09_architecture_decisions/0011-unified-confirmation-flow.md)). |

Known limit: a file changed while Drey was closed, under a tab restored
with unsaved edits, is not asked about ([§11](11_risks_and_technical_debt.md)).

## 10.2 No lock-in

| Situation | What happens | Mechanism |
|---|---|---|
| The user opens the vault in another editor. | Every note is readable Markdown; tags, tasks and links are plain text in it. | `specs/frontmatter-schema.md`. |
| The user uninstalls Drey and deletes its data folder. | No note content is lost. Indexes, history and settings are gone; the vault is untouched. | Indexes are caches ([§8](08_crosscutting_concepts.md#indexes-are-caches)); nothing derived is stored in the vault. |
| A note written elsewhere, without frontmatter, is saved in Drey. | It gains no frontmatter. | `touchUpdated` updates `updated:` only where the key exists ([ADR-0065](09_architecture_decisions/0065-git-vaults-source-control-plugin.md)). |

## 10.3 Private by default

| Situation | What happens | Mechanism |
|---|---|---|
| A fresh install is used with the assistant. | Requests go to the local endpoint only. | Hosted and CLI providers, web fetch and external tool servers are off by default ([ADR-0047](09_architecture_decisions/0047-llm-provider-abstraction.md), [ADR-0063](09_architecture_decisions/0063-mcp-client-and-assistant-tool-groups.md)). |
| A model wants to call an external tool or fetch a page. | The user is asked, with the exact arguments, unless that source was set to "allow". | The tool-approval dialog. |
| Markup in a note or a fetched page tries to run script in the window. | It does not run and cannot reach the file bridge. | Sanitizer, content policy, sandbox ([§8](08_crosscutting_concepts.md#renderer-hardening)). |
| Someone copies the settings file. | API keys in it are unreadable on another machine or account. | `config-secrets.ts`. |

Known limits: a note that embeds a picture from the web loads it, which
tells that server the note was opened.

## 10.4 Writing is never blocked

| Situation | What happens | Mechanism |
|---|---|---|
| No model server is running. | Editing, capture, search and saving work. Only the assistant's functions report that the model is unreachable. | No model call in the capture or save path. |
| A local model takes minutes to answer. | The request keeps running and shows a clock; the user can cancel at any time and keep working meanwhile. | No timeout, cancellable tasks ([ADR-0014](09_architecture_decisions/0014-no-chat-timeout-cancellable-tasks.md)). |
| The app starts with many plugins and a large vault. | The window appears while plugins activate; a splash shows progress and gives way after 30 s at the latest. | [ADR-0061](09_architecture_decisions/0061-window-first-startup.md), [ADR-0062](09_architecture_decisions/0062-splash-window.md). |

Known limit: an Action the user set to run on save calls the model
inside the save, so that save waits for the model. None ships enabled
([§11](11_risks_and_technical_debt.md)).

## 10.5 Features can be added and removed without touching the core

| Situation | What happens | Mechanism |
|---|---|---|
| A plugin is disabled in Settings. | After a restart its panels, commands and settings are gone and everything else works. What depended on it degrades with a message. | Registries; a missing provider is `null` ([§8](08_crosscutting_concepts.md#extension-through-registries)). |
| A plugin throws while starting. | It is quarantined and reported; the app starts with the others. | The plugin hosts, both sides ([ADR-0044](09_architecture_decisions/0044-runtime-plugin-system.md)). |
| A plugin built for another major SDK version is installed. | It is listed as incompatible and not loaded. | `PLUGIN_API_VERSION` gate. |
| A developer adds a feature as a plugin. | No file under `src/` or `electron/` changes, unless the feature needs a new kind of extension point. | The SDK in `shared/plugin-api/`. |

The last row is the one to watch: how often a new feature needed a new
SDK member is the honest measure of this goal
([§11](11_risks_and_technical_debt.md), architecture review 2026-10-13).
