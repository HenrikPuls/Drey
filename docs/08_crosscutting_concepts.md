# 8. Crosscutting Concepts

Rules and mechanisms that are not the property of one building block.
Each section says what the rule is and where it is decided, so a new
feature can follow it without reading the code first.

| Concept | One line |
|---|---|
| [Module boundaries](#module-boundaries) | Four parts, one direction of dependency. |
| [Extension through registries](#extension-through-registries) | The base offers a slot; a feature fills it. |
| [IPC typing](#ipc-typing-convention-established-in-milestone-1) | Every shape that crosses the bridge is declared once in `shared/`. |
| [Indexes are caches](#indexes-are-caches) | Anything derived from notes can be rebuilt from the notes. |
| [A model's change is confirmed](#a-models-change-is-confirmed) | Nothing a model proposes reaches a file unseen. |
| [Crash-safe file writes](#crash-safe-file-writes) | A replaced file is old or new, never half. |
| [Uncaught errors](#uncaught-errors-in-the-main-process) | Logged, and the user is told once. |
| [Renderer hardening](#renderer-hardening) | Sanitizer, content policy, sandbox. |
| [Secrets](#secrets-in-the-settings-file) | Encrypted on disk with the OS user's key. |

## Module boundaries

The app has four parts — renderer, main process, shared, plugins — and
dependencies run one way: everything may use `shared/`, plugins use the
base only through the SDK, and the base never reaches into a plugin. The
table of rules and what enforces each is in
[§5, "The dependency rules"](05_building_block_view.md#the-dependency-rules).

Inside the base, a folder that is a module exposes an `index.ts`; code
outside the folder imports that file and nothing behind it
([ADR-0016](09_architecture_decisions/0016-feature-module-convention.md)).
Angular components hold no logic of their own: a component reads state
from a service and calls it.

## Extension through registries

The base does not know its features. For every place a feature can
appear — a dock panel, a tab kind, a settings page, a menu row, a
command, an editor extension, a drop handler, a save hook, a search
provider — the base owns a registry and draws whatever is in it. The
base's own panels (Calendar, Files, Open windows) register through the
same call a plugin uses, so there is one path, not a built-in one and a
plugin one.

Two consequences worth knowing:

- **A missing plugin is a normal state.** Code that asks a registry for
  a provider must handle `null` (the tags plugin is disabled: `#tag`
  completion is empty, MCP `vault_search` answers with a clear error).
- **A new kind of extension is a change to the SDK.** It gets a minor
  version (`PLUGIN_API_VERSION`), an entry in "The seams"
  ([§5.0](05_building_block_view.md)), and it is additive: an existing
  plugin keeps working.

## Indexes are caches

The tag and section index, the task index and the backlink index are
all derived from the Markdown files. None is a source
of truth and none is stored in the vault. Each is kept current through
the save hook and the vault-change hook, and each can be dropped and
rebuilt by a full refresh. A feature that needs data about notes follows
the same pattern rather than writing a second copy of anything into the
notes.

## A model's change is confirmed

A model can propose a change to a note three ways: an Action, an edit
from the assistant, or a write through the MCP server. All three end in
the same dialog
([ADR-0011](09_architecture_decisions/0011-unified-confirmation-flow.md)),
which shows the change as a diff and writes only on confirmation. Each
writing tool group has its own rule (`tools.<group>.write`): note writes
ask by default; the template library, which the assistant may manage,
is written directly by default and can be set to ask. A call that leaves the machine (web fetch, an external tool
server) asks separately, showing its arguments
([ADR-0063](09_architecture_decisions/0063-mcp-client-and-assistant-tool-groups.md)).

## IPC typing convention (established in milestone 1)

Every data shape crossing the `contextBridge` boundary is defined once as
a TypeScript interface in a shared module (`shared/`), imported by both
the main process (implementation) and the renderer (consumer) — no
untyped `any` payloads across IPC. See
[05_building_block_view.md](05_building_block_view.md).

## Crash-safe file writes

`electron/safe-file.ts` is the one place that decides how the main
process replaces a file it must not lose.

- **Atomic replace.** `atomicWriteFile` / `atomicWriteFileSync` write the
  new content to a temp file beside the target, flush it, and rename it
  over the target. A crash, a power cut or a sync client (OneDrive)
  reading mid-write sees the old file or the new one, never a cut-off
  one. The temp name is `.<name>.<random>.tmp` — a dot-entry, so the file
  tree, the indexes and the vault watcher skip it. Used by
  `VaultManager.writeFile` / `writeBinaryFile` (every note write goes
  through the first), `app-config.json`, `vault-config.json`, the note
  history's index files and the session backups.
- **It never makes a save fail that used to work.** A rename blocked for
  a moment (virus scanner, sync client) is retried; if it stays blocked,
  or the temp file cannot be created, the write falls back to the plain
  in-place write. A read-only target is written in place directly, so
  the user still gets the error they got before. A linked note is
  written through the link.
- **Not covered, on purpose:** external tabs (`external:write`) keep the
  in-place write — a file outside the vault keeps its identity
  (hard links, its own permissions). Files that are only ever created,
  not replaced (a new daily note, a pasted asset), have nothing to lose.
- **An unusable config file is set aside, not overwritten.**
  `readJsonObjectGuarded` tells a missing file (first run) from one that
  exists but cannot be used (empty, cut off, not JSON). The latter is
  moved to `<name>.corrupt-<timestamp>` next to it and the app starts on
  defaults for that file; after the main window is shown, main names the
  file and the kept copy in one dialog. Applies to `app-config.json` and
  `vault-config.json`. Plugin config files keep the older "corrupt means
  empty" stance.

## Uncaught errors in the main process

Listening for `uncaughtException` (to log it, ADR-0032) switches off
Electron's own error dialog. `main.ts` therefore shows one itself, once
per session: what happened, where the log is, and *Quit Drey* / *Keep
running*. Quitting takes the ordinary exit path, so unsaved documents
are still asked about. `unhandledRejection` is logged only.

## Renderer hardening

Three layers stand between content the app did not write (notes of a
cloned vault, fetched pages, tool and model output) and the bridge that
can write files and run plugin backends:

1. **The HTML sanitizer** (`src/app/editor/live-preview/sanitize-html.ts`)
   — an allowlist for raw HTML in notes.
2. **The Content-Security-Policy** of the main window's page
   (`electron/content-security-policy.ts`). Scripts load only from the
   app's own bundle (`'self'`) and from plugin directories (`plugin:`);
   no inline script, no `eval`; the page connects to nothing on the
   network. Production gets the policy as a header from the `app://`
   handler, a dev run gets the same policy added to `ng serve`'s page
   (plus the live-reload socket). The production `index.html` carries no
   inline script — `inlineCritical` is off in `angular.json` for that
   reason. `e2e/fixtures/drey.ts` fails any test that leaves a policy
   violation in the console, so a new feature that needs a wider policy
   is noticed in the suite, not by a user.
3. **The process sandbox.** The main window runs with `sandbox: true`,
   `contextIsolation: true`, `nodeIntegration: false`. Its preload is one
   bundled file (`scripts/bundle-preload.mjs`).

What a new feature has to respect: no inline `<script>`, no `eval` /
`new Function`, no `fetch` to the network from the renderer (network
access belongs in main, behind IPC), frames only from `plugin:` or
`drey-asset:`. Widening the policy is a change to
`buildContentSecurityPolicy` and its spec, with the reason in the module
comment.

## Secrets in the settings file

`app-config.json` stays one readable JSON file, but its secret fields —
the LLM API key and, per external MCP server, the values of its
environment variables and HTTP headers — are stored as
`enc:v1:<base64>`, encrypted by the OS for the current user (Electron
`safeStorage`). `electron/config-secrets.ts` is the one place that says
which fields are secrets; `AppConfigStore` opens them when it reads the
file and seals them when it writes. In memory and over IPC the config
holds plain values.

- A plain value in a secret field is accepted (a key typed into the file
  by hand, or written by an older version) and sealed at that start.
- A sealed value that cannot be opened — the file came from another
  machine or account — becomes empty; the user is told once which keys
  to enter again, and the file as it was is kept beside it as
  `app-config.json.undecryptable-<timestamp>`.
- Where the OS offers no real protection (Linux without a secret
  service), values stay plain rather than looking protected.
