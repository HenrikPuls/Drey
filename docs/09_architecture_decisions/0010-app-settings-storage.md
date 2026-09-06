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
  keeps the active-vault path in `vault-config.json` under
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
