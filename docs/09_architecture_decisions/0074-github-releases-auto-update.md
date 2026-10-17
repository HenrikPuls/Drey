# 0074 — GitHub-Releases auto-update

## Status

Accepted (2026-10-17, milestone 82). The update check is a deliberate,
documented exception to the "everything that leaves the machine is opt-in
and off by default" rule of [ADR-0047](0047-llm-provider-abstraction.md) /
[ADR-0063](0063-mcp-client-and-assistant-tool-groups.md); see Decision.
Extends [ADR-0023](0023-windows-packaging-electron-builder.md) (the
release artifacts) and [ADR-0010](0010-app-settings-storage.md) (a new
base config slice — and the first main-side config write).

## Context

The repo is public and CI attaches the two Windows exes to a GitHub
Release on every `v*` tag. Until now the only way to learn about a new
release was to look: the installer is unsigned, there is no update
channel (`docs/11`), and the roadmap's item 8 ("Auto-update + code
signing") was parked behind an owner decision. The owner decided
(2026-10-17): build the update function against GitHub Releases; code
signing stays its own item.

Two mechanisms were weighed, decided with the owner:

- **electron-updater** (GitHub provider): battle-tested release
  resolution, SHA512 verification against `latest.yml`, differential
  blockmap downloads (relevant at ~100 MB per setup exe), assisted-NSIS
  install with relaunch — at the cost of a runtime dependency
  (~2–3 MB unpacked, same maintainer as the electron-builder already in
  the toolchain).
- **A minimal own check** against the releases API plus a manual
  download/open: zero dependencies, but no differential downloads, and
  Drey would own every edge case (checksum, resume, installer flags,
  CDN quirks) forever.

Owner's ruling: **electron-updater**, ask-first. A second ruling: the
startup check is **on by default** — see below. Ask semantics: three
buttons (Download / Skip this version / Remind me later), manual check
always available (Help menu, Settings → Updates). Channel: stable only
(the release GitHub marks "Latest"); a pre-release toggle is a possible
follow-up, not built.

## Decision

**electron-updater transports, Drey decides.** `autoDownload` and
`autoInstallOnAppQuit` are off; `allowPrerelease` is off. The flow lives
in `electron/updater/update-service.ts` (a state machine: idle →
checking → available → downloading → downloaded → install-on-quit) and is
inert unless the build is a packaged, non-portable Windows NSIS install
— a dev run, another platform and the portable exe report `unsupported`
and get the releases-page fallback (`shell.openExternal`), never a
half-working update. The renderer never touches the network; it triggers
and displays over the `UpdatesIpc` topic (`shared/ipc/updates.ts`).

**The startup check is on by default — a bounded exception.** The
"cloud calls are opt-in, off by default" rule guards *user content and
user-initiated calls* leaving the machine (notes to an LLM, searches to a
search provider). An update check sends nothing of the user's: it is the
app fetching a public release listing, the same class as an OS update
check — and an off-by-default updater fails at its one job, because the
users it protects never hear about fixes. The exception is bounded: only
the *check* is automatic; downloading, installing and restarting always
ask, and a Settings toggle (`updates.checkOnStartup`) turns the check
off entirely. `specs/roadmap.md`'s core-principles paragraph names the
exception alongside ADR-0047/0063.

**The asks are native dialogs in main** (`showMessageBox`, English, the
`startup-reports.ts` pattern): update available → *Download update /
Skip this version / Remind me later*; downloaded → *Install and restart /
Later*. "Skip this version" persists `updates.skippedVersion` (exact
match; any newer version asks again; a manual check always reports).
`AppConfigStore.patch()` is the first config write made by the main
process — same normalise/persist/notify path as `set()`, documented as
such; a concurrent renderer Settings draft can overwrite the skipped
version, which is benign (the next ask re-offers it).

**Quit goes through the save-before-exit prompt, always.** "Install and
restart" closes the window the ordinary way (`window.close()`), so the
exit prompt decides over dirty tabs; the installer is armed only when
the window *really* closed (`once('closed')` — a cancelled prompt
leaves the app running and a later plain quit installs the update the
user asked for). At `will-quit` — one-shot, after all hooks —
`quitAndInstall(false, true)` runs the assisted NSIS installer, which
installs per-user and relaunches Drey (electron-updater's
`autoRunAppAfterInstall` default). The relaunched instance takes the
single-instance lock cleanly because the old process is gone.

**CI is the updater's supply side.** `electron-builder.yml` declares
`publish: github (HenrikPuls/Drey)` so a pack writes `latest.yml`, the
`.blockmap` files and the packaged `app-update.yml` (metadata
generation, independent of `--publish never`); the CI release step
attaches `latest.yml` and the setup blockmap next to the exes. Releases
must be marked "Latest" (the stable channel); a pre-release is not
offered. Integrity while the app is unsigned is the SHA512 in
`latest.yml`; the SmartScreen warning stays until code signing ships.

**Corporate proxies are noted, not engineered for.** electron-updater
rides Electron's `net` stack: the Windows system proxy applies, and
Chromium trusts the Windows certificate store, so plain SSL inspection
with a machine-installed root CA works. A blocked network fails the
startup check *silently* (log only — a nag on every start would be
worse) and the manual check shows an error dialog with the hint to open
the releases page in a browser. No proxy settings, no credentials.

## Consequences

- Updating works only from a release that itself carries the updater's
  `app-update.yml` — installs of 0.6.0 (built without a publish config)
  make the hop to the first milestone-82 release by manual download;
  every release after updates itself. Documented in the manual.
- Differential updates need the previous release's blockmap on GitHub:
  deleting old releases silently degrades the next update to a full
  download (electron-updater falls back itself).
- The portable exe never self-updates by design (nothing to install
  over); it checks and points at the releases page.
- A dev run, `npm run app`, the Playwright e2e suite and `verify:pack`
  never reach the network over the updater — `app.isPackaged` is false
  there.
- One new runtime dependency (`electron-updater` + its tree) lands in
  the asar and the generated licenses list on the About page.
- Follow-ups not built: a pre-release channel toggle
  (`allowPrerelease`), code signing (its own roadmap item), an update
  history / "what changed" view (the release notes live on the releases
  page).
