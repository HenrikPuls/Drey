# 24. Binary vault asset write (`vault:save-asset`) for pasted images

## Status

Accepted — the capture half of "image paste in the editor + quick-capture"
(`specs/roadmap.md`, pulled forward from Phase 3). Builds on
[ADR-0001](0001-electron-process-split-contextbridge.md) (the IPC
boundary) and the existing `drey-asset://` render path
(`electron/main.ts` `registerAssetProtocol`, `VaultManager.resolveAssetPath`,
`src/app/editor/vault-image.ts`, the Live Preview `ImageWidget`).

## Context

Image **rendering** already worked end to end: `![](rel/path.png)` in a
note is rewritten to `drey-asset://asset/<vault-rel>` and served by a
privileged protocol handler from inside the active vault. What was missing
was getting an image *into* the vault in the first place — pasting a
screenshot or dropping an image file onto the editor.

Two gaps:

- **No binary write.** `VaultManager.writeFile` / the `vault:write-file`
  IPC channel take a `string` and write it `utf-8`. Image bytes cannot go
  through it.
- **Where the bytes land and what they are called.** The roadmap's Phase-3
  wording said a single global `assets/`. The project owner chose instead:
  one `attachments/` folder **beside each note**, holding the images that
  note references; names `YYYY-MM-DD-HHmmss-<short hash>` (sortable,
  readable, collision-safe without a dedupe lookup).

## Decision

**A new binary IPC channel `vault:save-asset` →
`VaultManager.saveAsset(bytes, ext, noteRelPath)`, a pure
`shared/asset-name.ts` naming helper, and a per-note `attachments/`
folder.**

- `shared/asset-name.ts` (pure, dependency-free, Vitest-covered in
  `src/app/services/asset-name.spec.ts`):
  - `imageExtension(mimeOrFilename)` — `image/png` → `png`, … , or a
    dropped file name's extension; `null` for anything not a known image
    type, which is the renderer's signal to let the default paste happen.
  - `assetTimestamp(date)` — `YYYY-MM-DD-HHmmss`, **local** time (matches
    when the user pasted, same convention as the daily-note file names).
  - `assetFileName({ date, hashHex, ext })` — `<timestamp>-<6 hex>.<ext>`.
    Throws on a malformed extension or < 6 hex digits so a bad name can
    never reach disk.
  - `ATTACHMENTS_DIR = 'attachments'`.
- `VaultManager.saveAsset(bytes: Uint8Array, ext, noteRelPath)`:
  - hashes the bytes with `node:crypto` SHA-256 (the 6-hex suffix); the
    renderer sends raw bytes and never hashes.
  - target folder is `<dir(noteRelPath)>/attachments/`; a `noteRelPath`
    with no folder part (a bare name, an unsaved scratch tab) falls back
    to the vault root's `attachments/`. `mkdir -p`, then write.
  - **never overwrites**: an existing name (same second, same 6 hex) gets
    `-2`, `-3`, … . No dedupe — identical pastes make distinct files, per
    the naming choice.
  - returns the path **relative to the note's own folder**
    (`attachments/<name>`), which is exactly what goes inside `![](…)` and
    what `resolveVaultImageUrl` (already note-relative) resolves back.
  - path safety is the existing `resolveInVault` guard — `noteRelPath`
    comes from `EditorService.openPath()`, but the channel is a public IPC
    surface so the guard is not assumed.
- `saveVaultAsset` is added to `DreyApi` / `preload.ts` / the `main.ts`
  handler table alongside the other `vault:*` channels. `Uint8Array`
  crosses `contextBridge` via structured clone unchanged — no
  base64/string round-trip.

### Alternatives considered

- **Widen `writeFile` to accept `string | Uint8Array`.** Overloads one
  channel with two very different contracts (text note write vs. opaque
  blob) and still needs the naming/folder logic somewhere. A separate
  channel keeps each handler single-purpose (the codebase's stated style).
- **Global `assets/` (roadmap wording).** Rejected by the project owner in
  favour of images living next to the note that uses them, so moving a
  note's folder keeps its images and a directory stays self-contained.
- **Content-hash-only names (dedupe).** Rejected: the timestamp makes the
  vault browsable in file order, and dedupe across a whole vault is not
  worth the lookup on every paste.
- **Hash in the renderer (Web Crypto).** No benefit — the bytes already
  cross to main, which has `node:crypto`; keeps the renderer smaller.

## Consequences

- First binary write path into the vault. Future non-text vault content
  (exported PDFs, attachments) has a channel shape to follow.
- An `attachments/` folder can now appear anywhere in the vault. The tag
  index already ignores non-`.md` files; the file tree shows it like any
  folder.
- `saveAsset` does not touch the tag index or fire `mcp:vault-changed` —
  it writes no `.md`. The renderer refreshes the file tree itself after a
  paste (see the capture-side change).
- No new dependency (`node:crypto` is built in).
- A paste with no active vault can't be saved; the renderer keeps the
  default text paste and shows a transient notice (capture-side).
- Later: [ADR-0028](0028-drag-drop-into-the-editor.md) adds a sibling
  `vault:save-asset-from-url` that fetches a web image in the main process
  and reuses `saveAsset` to store it.
