# 67. In-app help documents

## Status

Accepted. Adds the Help menu (manual + generated shortcuts + an About
deep link) and, under it, a small base mechanism: read-only pinned
"help" tabs whose relative image refs resolve against the app origin
instead of a vault.

## Context

The user manual lived only in the repository (`docs/manual.md`) — good
for a reader on GitHub, invisible to a user of the packaged app. The
owner asked for three things: the manual reachable from the app (Help),
a keyboard-shortcuts document next to it, and both opened in the editor
as a **read-only, pinned tab** — not a dialog, not an external browser.

The pieces that did not exist:

- No open-document mechanism was read-only *and* pinned. Scratch tabs
  (`openScratch`) are dirty-from-the-start and save through Save-As;
  external tabs (`external://`) are pinned but editable and bound to an
  OS-collected path; plugin doc kinds carry no editor surface at all.
- The Live Preview resolves `![](…)` refs through
  `shared/asset-refs.ts` against the *vault* (`drey-asset://`). Help
  images live in the app bundle, not in any vault.
- A manual must ship with the app: in dev (`ng serve`), in the packaged
  asar, from one source of truth in `docs/`.

For the shortcuts list, a static file would drift from the command
registry the moment a milestone adds a command; the palette already
reads the live registry.

## Decision

**1 · The manual ships through `public/`.** `scripts/sync-manual.mjs`
mirrors `docs/manual/` (markdown + screenshots) into `public/manual/`
as part of `prebuild` (and `predev`); Angular copies `public/**`
verbatim under the app origin, and the packaged `app://` protocol serves
it from the asar with zero electron-builder changes. The mirror is
committed (byte-stable, the `licenses.json` convention) and asserted by
`scripts/verify-pack.mjs`. The renderer fetches it **relative**
(`manual/manual.md`) — the same code path resolves against `ng serve`
in dev and `app://` packaged.

**2 · Help tabs are a base `OpenDoc` flavour.** `OpenDoc.help:
{ assetBase }` marks an in-app help document. It is created through
`EditorService.openHelpDoc(path, name, content, assetBase)` — pinned,
`viewMode: 'view'` (the read-only rendering mode), and **clean by
construction** (buffer === saved, `existsOnDisk` true), so save, the
exit prompt, `.drafts/` auto-save and the dirty-close dialog are all
no-ops by the existing rules rather than new special cases. Its surface
stays non-editable in every mode: `setViewMode` refuses help docs, and
the editor pushes the edit-lock (ADR-0049's `setEditable(false)`) for
them like a live-edit lock. The session snapshot skips help tabs — the
Help menu reopens them; a restart starts without them. The `⋯` menu
hides its document actions (Save as, history, PDF, tag suggestions)
for them.

**3 · Images resolve against the app origin.** A help doc's
`assetBase` (`manual/`) is threaded into the Live Preview's
`resolveImage`: relative refs become relative URLs (`manual/img/…`) the
page origin serves; `http(s)`/`data:` pass through; an explicit scheme
or a `..` escape yields nothing. No protocol is hardcoded — dev and
packaged behave identically, and the CSP needs no widening (`'self'`
covers both fetch and `img-src`).

**4 · The shortcuts document is generated at open time.** Help →
*Keyboard shortcuts* builds its Markdown from the live
`KeybindingService` registry (base and plugin commands, mouse side
buttons included) plus a fixed table of shortcuts that live outside the
registry (editor keymap, standard editing chords, the global capture
hotkey). It can therefore never contradict the command palette.

**5 · The Help menu is base chrome.** `MenuService` gains a `help` menu
with *User manual* (`F1`, the command `help.manual`), *Keyboard
shortcuts* (`help.shortcuts`) and *About Drey*, which opens Settings
directly on the About category (`SettingsService.openScreen` takes an
optional category). Both commands are registered like any other, so the
palette lists them too.

## Consequences

- Users of the packaged app can read the full manual, with screenshots,
  offline; the repository stays the single source (the mirror is
  regenerated on every build and never hand-edited).
- Help tabs interact with panes, drag & drop and focus like any tab —
  but they are deliberately absent from the session snapshot, so a
  restart is not littered with them.
- `docs/manual/` moving wholesale (new sections, renamed images) needs
  no code change — the sync script mirrors whatever is there; the
  verify-pack assertion catches a packaging regression.
- A plugin that wants its own in-app documentation can reuse
  `openHelpDoc` with its own `assetBase` (its renderer directory) —
  nothing in the mechanism is manual-specific.
