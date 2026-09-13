# 0051 — Multi-vault registry

## Status

Accepted (milestone 28, in progress)

## Context

The app knew exactly one vault: `vault-config.json` persisted a single
`activeVaultPath`, and every path in the system — open tabs, the session
snapshot, drag & drop payloads, `drey-asset://` URLs, MCP tools, plugin
`ctx.vault.*` calls — was a bare vault-relative string with no vault
identity. The docs anticipated "Phase 3 multi-vault"
(`docs/03`, ADR-0010's per-vault settings sketch, ADR-0019's note that the
switcher was reduced to "Open other vault …" with no registry).

The owner pulled this forward: the Files panel should show several
registered vaults at once (one section per vault, per a reference
screenshot of the existing vault header row), files from any vault open
and edit side by side, search gains document/vault/all-vaults scopes, and
an agent-workflow layer on top of Markdown vaults is planned — stable
vault identities are its enabler.

## Decision

**Registry, not a single path.** `vault-config.json` (still its own file
per ADR-0010's split — not `app-config.json`) becomes version 2:
`{ version: 2, vaults: VaultRegistration[], activeVaultId }` with
`VaultRegistration { id, name, path }`. The v1 shape migrates on first
read (one registration, id minted, persisted straight back; a missing or
corrupt file stays an empty registry).

**Ids are minted, names are cosmetic.** An id is
`'v' + 10 hex chars`, minted once at registration and never changed — it
survives folder renames and moves because it lives in the registry, not on
disk. It is URL- and filesystem-safe and contains no `:`, which the key
formats below rely on. The display `name` (default: folder basename) is
user-editable and may duplicate; the id is the only identity.

**One vault is active.** Creating content — daily notes, quick capture,
the Add entry drawer, assistant chats, calendar, untitled-draft commits,
scratch-tab Save-as — targets the active vault, switchable from the Files
panel. A registration whose folder has disappeared stays registered
(`exists: false`, greyed row); the active accessors then behave like "no
active vault", exactly as the pre-registry version behaved for a missing
folder, so a remounted OneDrive drive recovers on restart.

**Vault identity through IPC: optional trailing `vaultId`, not new
channels.** Every existing `vault:*` data method gains an optional last
`vaultId?: string` parameter defaulting to the active vault, so ~90% of
call sites (daily notes, drafts, chats, the plugin facade defaults)
compile and behave unchanged. Six new registry channels exist only for
registry management (`vault:list/add/remove/rename-vault/set-active/
reveal-folder`); the old `vault:select` picker-overwrite is removed —
"switching" is now `set-active`. `VaultChangedPush` carries `vaultId?`:
present = scoped to one vault, absent = registry-level/all vaults.

**Document identity: `vaultId::path`.** `OpenDoc` gains `vaultId` and a
computed `key = vaultId::path` (bare path for vault-less docs — scratch
tabs and plugin doc kinds). Pane tabs, tab drag, the session snapshot,
and the Files panel's selection/collapse/drag state key on this composite
(`:` is illegal in minted ids and in Windows path segments, so the split
is unambiguous; `browser://` keys never collide). `path` stays
vault-relative — it is what IPC speaks and what the UI displays. Plugin
surfaces keep seeing clean paths; they resolve via active-vault-first,
unique-match-fallback and can pass an explicit `{vaultId}` where the SDK
grew one.

**Cross-vault moves are copy + delete.** `renameEntry`/`copyEntry` accept
a source and a destination vault; differing vaults copy (EXDEV-safe
`fsp.cp`) then delete, carrying a `.md` note's assistant sidecar and
cleaning up a failed copy. The handler announces an all-vaults refresh so
both indexes rebuild. Same-vault moves stay a plain rename.

**Per-vault everything downstream.** The watcher (one chokidar per
registered vault, reconciled on registry changes), the change announcer
(vault-scoped batches), the own-write ledger (`vaultId:path` keys — which
also fixes a latent cross-vault suppression bug the old watcher restart
used to mask), the tags/tasks indexes (per-vault), the search provider
(scope: active / one vault / all), and the MCP tools (optional `vault`
argument, id or unique display name, default active) all follow the
registry. Asset URLs become `drey-asset://<vaultId>/asset/<path>` — the
host carries the vault so the same relative path resolves per vault.

**Non-active-vault tabs follow their own vault** for wikilink-create
(a `[[link]]` from a vault-B note creates its target in vault B — creating
it elsewhere would leave the link permanently unresolved) and Save-as
(a vault-B tab roots its Save-as dialog at vault B so the note stays
inside its own tree and index).

## Consequences

- Session snapshots bump to version 2 with per-tab `vaultId`; a tab whose
  vault is no longer registered is dropped silently. v1 snapshots still
  restore (mapped onto the active vault); that bridge can go one release
  after this ships.
- `documents.setBuffer`/`save`-style plugin calls that take a bare path
  become ambiguous across vaults in principle; resolution is
  active-vault-first, then unique-match. Plugins that need precision pass
  `{vaultId}` (the SDK grew it, minor version 5 → 6).
- The assistant's in-process tools (`vaultTools`, live-edit `doc_*`)
  remain active-vault in this milestone; threading the vault argument
  through them is follow-up work alongside the assistant's M-B scopes.
- OCR on an image tab from a non-active vault reads through the active
  vault's `ctx.vault` — same follow-up.
- Cross-vault drag & drop moves files but not tags/task index state
  beyond the rebuild both vaults run; interrupted copies clean up after
  themselves but are not resumable.
- Per-vault settings overlays (ADR-0010's sketch) remain unbuilt — the
  registry is the additive hook they will hang off.
- Files panel owns all vault management (root-row context menu); there is
  deliberately no second management surface in Settings.
