# 61. Window-first startup: activation races the renderer, gated IPC

## Status

Accepted (milestone 61). Amends the boot order ADR-0044 implies (plugins
activate before the window exists); adds startup instrumentation and the
first startup-perc pass. The perceived-startup half (splash window with
progress) is milestone 62 and builds on this.

## Context

The packaged exe felt slow to start. Measured (the `[startup]` marks in
`<userData>/logs/drey.log`, milestone 61), the boot was fully serial:

1. Main waited out plugin discovery + activation, MCP transport and the
   watcher sync **before creating the window** — a blank taskbar for the
   whole main-side phase.
2. The renderer then parsed ~1.5 MB of JS, and its app initializer
   activated **ten plugins sequentially** — each `plugin://` import a
   protocol round trip through main — before Angular painted anything.
3. Session restore read each tab's file **one IPC round trip at a time**.
4. Main fired its own full-vault index round (`emitVaultChange(refresh)`)
   at boot, on top of the round the renderer's `VaultService`
   constructor triggers — three full vault re-reads (tags, tasks,
   backlinks) contending with the very file serving the boot needed.

Questions with real alternatives: reorder how far (window truly first?
plugins after first paint?), how the renderer is kept from observing a
half-activated plugin host, and whether the custom-scheme responses can
get V8 code caching.

## Decision

**1 — The window comes first; activation runs concurrently.** `whenReady`
constructs the cheap services, registers the protocols and IPC handlers,
starts `pluginHost.discoverAndActivate()` (its completion promise is
assigned synchronously, before the window exists), then creates the
window. The renderer's JS parse (~0.5 s) now overlaps main-side
activation (~50 ms) instead of queueing behind it.

**2 — Gated IPC instead of ordering.** The handlers that expose
plugin-owned state — `plugins:list`, `plugin:invoke`, `search:vocabulary`
/ `tags:suggest`, and `vault:refresh` — `await host.activationDone()`.
The renderer can therefore never see an empty plugin list, invoke a
half-registered method, or fire its boot refresh round onto unregistered
vault hooks. Cost: those invokes block for the (short) remainder of
activation; benefit: no ordering coupling between main.ts construction
and window creation.

**3 — `onMainWindowCreated` replays.** With the window existing before
activation finishes, a plugin subscribing during a late `activate()`
would never hear about it. `PluginHost` remembers the announced window
and replays it to late subscribers (microtask, so the subscribe call
returns first) — identical behaviour for early and late plugins.

**4 — Renderer plugins load in parallel.** `PluginHostService.loadAll`
prefetches every `plugin://` module graph with `Promise.all`, then
activates them sequentially in descriptor order (registration order for
widgets / settings pages / menus stays deterministic). Ten serial
protocol round trips collapse into parallel fetches; measured 66–70 ms
total on the dev machine.

**5 — One boot round, not two.** Main's own `emitVaultChange(refresh)`
at boot is removed: the renderer's `VaultService` constructor already
runs the identical full announcer round (plugin index rebuilds + tree
push), and with decision 2's gate it now provably lands on fully
registered hooks. The index sweeps (tags/tasks/backlinks, plus the
assistant's semantic catch-up) still run in the background at boot but
no longer double up.

**6 — Session restore reads in parallel.** All tab reads
(`readVaultFile` + `readSessionBackup`) fire concurrently and are then
applied in order (`openFile` takes an optional `prefetched` result; a
failed prefetch falls back to the sequential path so error UX is
unchanged). Pane layout semantics are order-dependent and stay
sequential.

**7 — Custom-scheme serving centralized** (`electron/protocol-cache.ts`):
streamed responses (the plugin handler used to buffer whole files),
explicit MIME map retained, ETag (`mtime36-size36`) + 304 + `no-cache`
for non-hashed files, `immutable` for content-hashed bundle files, and
the `codeCache` scheme privilege on `app` + `plugin`. Measured honestly:
Chromium (Electron 44) keeps custom-scheme responses out of its HTTP
cache — no `If-None-Match` ever arrives and the code cache privilege
moved nothing on the dev machine. Kept because it is correct,
forward-compatible and replaced the buffering; not counted as a win.

**8 — Startup instrumentation, always on.** `startupMark` lines in
`drey.log` (main: ready → services → window → per-plugin activation →
complete; renderer: bundle evaluated → plugins loaded → shell painted →
session restored), plus `scripts/measure-startup.mjs` (Playwright,
packaged exe, wall-clock to titlebar). The favicon dropped 370 KB →
15 KB (its own sizes, not the exe icon's).

## Consequences

- Warm starts on the dev machine: ~5–10 % faster to titlebar (the
  machine was never the worst case); the structural wins (overlap,
  parallel loads, single index round, parallel restore) scale with
  slower disks, more plugins and more tabs. The irreducible floor —
  process spawn + Defender's first-launch scan of a fresh build (up to
  ~28 s in the measurements, ~3–9 s typical) — is untouched and is what
  the milestone 62 splash addresses.
- A plugin whose main activation is slow no longer delays the window,
  but does delay the gated handlers — the renderer boot waits for it in
  `listPlugins` instead of the window appearing later. Same total wait,
  visible progress earlier.
- IPC handlers touching plugin state must remember the gate; forgetting
  it reintroduces the boot race silently (empty vocabulary, dropped
  index round) rather than loudly.
- `onMainWindowCreated` callbacks can now fire during `activate()` (via
  the replay) — plugins must tolerate that, which all current ones do
  (they only store the window).
