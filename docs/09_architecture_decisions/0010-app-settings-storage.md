# 10. App settings in a user-data config file, not the vault

## Status

Accepted — implemented with the Settings screen (LLM connection + Actions
system).

## Context

The Settings screen introduces persistent configuration the app never had
before: the LLM connection (enabled flag, base URL, selected model),
action prompt templates, trigger → template mappings, and per-action
confirmation preferences.

Where does this live? The vault is "just a folder of Markdown files" (a
core principle in `specs/roadmap.md`), and everything the app has written
so far — notes, master documents, the inbox — is vault content. It would
be *plausible* to drop settings in as another Markdown/YAML file
(`.drey/settings.md`), and that plausibility is exactly the trap: it is
the wrong call.

- Settings are **application** configuration, not knowledge. They are not
  something the user writes, reads back as a note, or wants versioned
  alongside their content or synced to another device as "a note".
- A vault can live on OneDrive and be opened from more than one machine
  over time (and Phase 3 adds real multi-vault). The LLM endpoint, the
  model list, prompt templates and confirmation habits are properties of
  *this install on this machine*, not of the knowledge base. Binding them
  to a vault would mean re-configuring per vault, or worse, one machine's
  `localhost:1234` leaking into a vault another machine opens.
- The app already has this exact pattern: `electron/vault-manager.ts`
  keeps the vault registry (`{ vaults: [...], activeVaultId }`, v2 since
  [ADR-0051](0051-multi-vault-registry.md)) in `vault-config.json` under
  `app.getPath('userData')`. Settings are the same kind of thing.
  (Editor content zoom later joined `app-config.json` as
  `editor.fontScale` — see ADR-0015.)

## Decision

App settings live in **one JSON file, `app-config.json`, under
`app.getPath('userData')`** — global, independent of which vault is
active.

- `shared/app-config.ts` owns the shape (`AppConfig`), the defaults
  (`DEFAULT_APP_CONFIG`, including the two built-in action templates), and
  `normalizeAppConfig` — a total parse that fills missing keys, re-injects
  the built-ins, and drops malformed entries, so both sides of the IPC
  boundary always see a complete object. Same defensive stance as
  `readConfig` in `vault-manager.ts`, one shape deeper.
- `electron/app-config.ts` (`AppConfigStore`) does only fs: read on
  construction, `set(next)` normalises + writes + returns the stored
  result.
- IPC: `config:get` / `config:set`, always the whole `AppConfig` — there is
  only ever one editor (the user, in this window), so a full replace is
  simpler and race-free versus field-level patches, and
  `normalizeAppConfig` on the main side is the guardrail.

### The Settings screen edits a draft; only **Save** crosses IPC

`SettingsService` holds two signals: `config` (what is persisted) and
`draft` (what the screen edits). Every pane mutator writes the draft;
`save()` sends it and adopts the normalised result, `discard()` throws it
away. `isDirty` is a structural compare (`shared/deep-equal.ts`).

This replaced a persist-on-every-change design that had two faults:

1. **It could destroy input as you typed.** Each edit round-tripped
   through IPC and the renderer adopted whatever came back. A main process
   that didn't yet know a field — trivially reachable in dev, since
   `npm run dev` only builds `dist-electron/` once while `ng serve`
   hot-reloads the renderer (see `docs/11`) — stripped it and the renderer
   dutifully cleared the input. This is how the `apiKey` field appeared to
   "not save": the value never survived the first keystroke's round-trip.
   With a draft, a contract mismatch can only fail an explicit Save, where
   it is visible, instead of silently eating keystrokes.
2. **There was no "unsaved changes" state** to warn about on close.

Consequences: runtime behaviour (`llmEnabled`, `manualActions`) reads
`config`, never `draft`, so an unsaved edit cannot change what the app
does. Closing the screen with `isDirty()` raises an inline save / discard /
keep-editing bar. Text inputs fire on `(input)` and store the value
**verbatim** — trimming per keystroke would rewrite the bound `[value]`
and eat the character just typed; `normalizeAppConfig` trims on save.

The one deliberate exception is the confirmation dialog's "don't ask again
for this action" checkbox (`setTriggerConfirmImmediate`): it happens
outside the Settings screen and persists at once, applying the same edit
to an open draft so the screen stays in step.

### Probing the endpoint uses what is typed, not what is saved

Because Save is now explicit, "Load models" and "Test connection" would
otherwise test stale values. `llm:list-models` / `llm:test-connection`
take an optional `LlmEndpoint` override (`{ baseUrl, apiKey }`) that the
Settings screen fills from the draft. `chat()` never takes an override —
actions and Ask always run against settings the user actually committed.

### The config file holds one secret: the LLM API key

`llm.apiKey` is a bearer token sent as `Authorization: Bearer <key>` on
every request to the model endpoint — needed by Unsloth Desktop
(`sk-unsloth-…`) and by llama.cpp/vLLM when started with an API key;
ignored by LM Studio. It is stored **in plain text** in the same
`app-config.json`.

Deliberate, with the trade-off stated rather than hidden:

- The key authenticates against a **local** server the same user already
  controls. An attacker who can read `app-config.json` is already running
  as that user and can talk to `localhost:8888` directly without it.
- The alternative — Electron's `safeStorage` (DPAPI/Keychain) — would put
  the key in a separate encrypted blob, make the config file no longer
  hand-editable, and add a failure mode (`safeStorage.isEncryptionAvailable()`
  is false on some Linux setups). Not worth it for a localhost token.
- If a **remote/cloud** key ever gets stored here, revisit: that is a
  different threat model. Tracked in
  `docs/11_risks_and_technical_debt.md`.

The Settings field is `type="password"`, and the key is never logged — HTTP
failures report the status and a hint, not the header.

> Superseded on 2026-10-11 — see "Later change — secrets are encrypted on
> disk" at the end of this file. The revisit condition above was met when
> hosted LLM presets and external MCP servers arrived.

### Global vs. per-vault — flagged, decided global for now

The question was raised explicitly. For Phase 1 (single vault) every
setting is global. If a future need appears for a per-vault override
(e.g. a vault that should use a different model, or ship its own action
templates), the shape can grow a `vaults: { [path]: Partial<AppConfig> }`
overlay layer merged on top of the global base — an additive change, not
a migration. Not built now: it has no user before Phase 3 multi-vault.

## Consequences

- Settings survive a vault change and a vault move; they do not travel
  with a vault copied to another machine (intended).
- `AppConfigStore` is constructed in `app.whenReady` alongside the other
  managers and injected into `LmStudioClient`, `ActionRunner`, and the
  `config:*` handlers.
- `normalizeAppConfig` is pure and Vitest-covered; `AppConfigStore` is a
  thin fs sequencer with no unit test, consistent with ADR-0007's
  main-process split.
- A corrupt or missing file falls back to `DEFAULT_APP_CONFIG` silently
  (LLM features default **off**), never a crash.
- The renderer bundles `shared/app-config.ts` and `shared/actions.ts`
  (for `resolveActions`); both are dependency-free. The frontmatter/`yaml`
  rewrite helpers were kept out of `shared/actions.ts` in
  `shared/action-apply.ts` (main only) so `yaml` stays out of the
  renderer bundle (ADR-0007).

## Later change — secrets are encrypted on disk (2026-10-11)

The plain-text key was accepted for a token that only reached a local
server. Since then the same file came to hold real cloud keys (the hosted
LLM presets, ADR-0047) and the credentials of external MCP servers
(their environment variables and HTTP headers, ADR-0063). That is the
"different threat model" this ADR said to revisit for: a backup, a synced
profile folder or a support upload of `app-config.json` now leaks
credentials that work from anywhere.

**Decision.** The secret fields — and only those — are encrypted with
Electron's `safeStorage` (DPAPI on Windows, the keychain on macOS, the
secret service on Linux) and stored in place as `enc:v1:<base64>`. The
objections recorded above are answered by how it is done, not dropped:

- *"A separate encrypted blob."* There is none. The value sits in the
  same field of the same file.
- *"The config is no longer hand-editable."* Everything but the secret
  values still is. A secret typed into the file in plain text is read
  and sealed at that start, so entering a key by hand keeps working.
- *"`isEncryptionAvailable()` is false on some Linux setups."* Then the
  value stays plain, as before — including the `basic_text` backend,
  which encrypts with a fixed password and would only look protected.

`electron/config-secrets.ts` defines which fields are secrets (one walk
used for sealing and opening); `AppConfigStore` applies it at the file
boundary. In memory and over `config:get` / `config:set` the config is
unchanged — the Settings screen shows and edits the key as before.

Considered and not done: a separate secrets file or the OS credential
manager per key (more moving parts, the settings no longer in one place);
keeping the key away from the renderer entirely (the Settings field would
become write-only — a UI change of its own, still open).

Consequences:

- A config file copied to another machine or OS account loses its keys.
  The app says once at startup which ones, leaves those fields empty and
  keeps the file as it was beside it
  (`app-config.json.undecryptable-<timestamp>`).
- Encryption protects the file at rest, not against a program running as
  the same user.
- `AppConfigStore` has a unit test now (`electron/app-config.spec.ts`),
  with the cipher passed in.

## Later change — every change applies as it is made; no Save, no Discard

The Settings screen had grown two models. Core pages edited a draft with
*Save* / *Discard* and an "unsaved changes" bar on close; plugin pages
(ADR-0044 rule 3) saved as you edit. The footer changed from page to
page, and a user had to know per page whether a change already counted.
Desktop settings conventionally apply at once (macOS, GNOME and Windows
settings, VS Code, Obsidian); an explicit Save belongs to forms whose
half-filled state is invalid, which a settings page is not.

Decision: one model. A change applies as it is made, on every page. The
footer shows the save status and a single **Close** button.

The draft stays, because the fault that introduced it (above: input
erased while typing, when a value round-tripped through IPC on each
keystroke) is real. What changed is who saves it:

- `SettingsService` saves the draft by itself 400 ms after the last edit.
- While a text field has the focus the save waits; it runs when the field
  is left, on Enter, when the window loses focus and when the screen
  closes. A half-typed URL or folder name therefore never reaches disk,
  and the bound `[value]` is never rewritten under the caret.
- A save writes **only the top-level sections the draft changed**, onto a
  fresh read of the stored config. Sending the whole draft could undo
  what a plugin page had written through `api.appConfig.patch` since the
  screen opened — a fault the Save button already had.
- An edit made while a save is under way is kept and goes out with the
  next one.
- A failed save keeps the draft and the screen, shows the error in the
  footer, and turns the button into "Close without saving".

Consequences:

- No rollback. Trying a theme and not liking it means picking the old one
  again.
- A switch acts when clicked. The one that can cost data — MCP "YOLO
  mode" — asks before it turns on.
- A new MCP server exists on disk before it has a command. Main reports
  that as "no command configured"; the page shows "Enter a command to
  connect." instead. Its id follows its name while the page that added
  it is open, no longer "until first saved".
- Forms that *create* something (an MCP server, an entry template) keep
  their own Add / Remove buttons; that is not a page-level save.

## Later change — plugin settings live in the plugin's own config (2026-10-18)

The 2026-10-13 architecture review flagged (finding 4, roadmap item A6)
that the base settings file had become a landing pad for feature data:
`AppConfig` carried the actions slice — prompt templates, triggers, and
with them the built-in prompt texts — although the engine and the
settings page that own that data had already moved into the assistant
plugin (ADR-0044 stage 7). Every new plugin setting would have meant
editing base files.

**Decision.** The rule from now on: **a plugin's settings live in the
plugin's own config** (`<userData>/plugins/<id>/config.json`, the
`ctx.config` / `api.settings` store). The actions slice moved there
(key `actions` in the assistant plugin's config), normalized on every
read by the shared `normalizeActionsConfig` — the built-ins re-inject,
the retired built-in stays retired, legacy prompts refresh, exactly as
`normalizeAppConfig` did before.

- **Migration.** A one-time step before plugin activation
  (`electron/plugin-host/actions-migration.ts`) copies a stored
  `app-config.json` `actions` key into the plugin config. Idempotent:
  once the plugin config holds the key it wins; a base file without the
  key is a no-op. The stale key is left in the base file rather than
  rewriting a file that holds sealed secrets — `normalizeAppConfig`
  never serves it again, so it is dead data with a documented grave.
- **The base seams stayed narrow.** The editor's "Suggest tags" autotag
  (`TagSuggester`) reads the actions config through the plugin host; the
  confirmation dialog's per-trigger "don't ask again" flips through the
  new `config:set-trigger-confirm` handler instead of the whole-config
  `config:set` round; and the tags plugin's Summarise takes the stored
  `search-summary` prompt from the new `ctx.llm.actionPrompt(builtin)`
  read seam (SDK 1.28) instead of reaching into app config.
- **Deliberately still here** (application configuration, not plugin
  settings, by this ADR's own definition): the `templates` slice — its
  `dir` is vault layout shared by four consumers (the tags and tasks
  indexes exclude the folder, the assistant's prompt folder hangs off
  it, a change re-fires the vault refresh) — and the `entry` slice,
  which is all base. The rule governs where *new* plugin settings go;
  it does not ask these two to move.

Consequences: adding a plugin setting can no longer mean editing a base
file; the settings screen's plugin pages read their own store, so a
plugin's data travels with the plugin; and the base `AppConfig` type no
longer compiles knowledge about the assistant's features.
- The ADR-0020 later change (Appearance previews from the draft until
  Save) is reduced to: the draft shows a change before its automatic
  save.
