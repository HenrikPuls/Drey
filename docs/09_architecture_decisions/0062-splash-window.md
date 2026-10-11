# 62. Splash window with progress, hidden-until-ready handover

## Status

Accepted (milestone 62). The perceived-startup half of the 2026-10-10
startup work — the speed half is ADR-0061. Chosen by the project owner
over an in-window splash (overlay inside the main window): a separate
frameless window is the classic pattern and costs one extra small
BrowserWindow for a fraction of the boot.

## Context

Milestone 61 removed everything removable from the boot path, but two
things remain that no code can remove:

- **The cold-start floor.** Process spawn plus Windows Defender's scan
  of a freshly written/freshly updated exe — measured at ~3–9 s, one
  28 s outlier. The app can only make that wait *look* intentional.
- **The sub-second blank.** Even warm, the window painted ~1 s after
  launch; before that the user saw a blank dark frame (pre-M62) or
  nothing at all (the window was created but had no content).

The open question was what the user sees during that time — nothing, a
static frame, or an informed splash — and how the swap from splash to
app happens without flashes.

## Decision

**1 — A separate splash window, shown first.** `whenReady` creates a
small frameless, non-resizable, `skipTaskbar` window (~400×300, centered)
before anything heavy runs. Its page (`public/splash.html`) is
dependency-free — inline CSS + a few lines of JS over a micro-preload —
so it paints the moment it loads: the About-page mark (`icon.png`, which
sits in the same dist root), the wordmark, the version, a thin bar and a
sentence-case activity line. Token values are copied from
`src/styles.css` (no shared stylesheet at that point in the boot).
`SplashController` (`electron/splash.ts`) latches the latest progress
payload and replays it on `did-finish-load`, so stages pushed before the
page listens are not lost.

**2 — A shared progress scale.** Main pushes `Starting…` → `Loading
settings` → `Loading plugin {name}` (one step per main entry, the
15–60 % band, named by manifest name) → `Starting the interface`. The
renderer adds its stages over a fire-and-forget `startup:progress` send:
`Preparing workspace` (first paint) → `Restoring session…` → done. The
bar is determinate-by-stages — it jumps with a short CSS transition, no
fake animation.

**3 — The main window is hidden until ready.** The boot window is
created with `show: false`; when the renderer reports ready
(`startup:ready`, sent after plugins + first paint + session restore +
the daily-note fallback), main `show()`s it and closes the splash ~120 ms
later (the brief overlap hides the swap). The user never sees a blank
dark frame: splash → painted app. Hidden windows still render
(`paintWhenInitiallyHidden` default), so the app is genuinely painted
under the splash.

**4 — Fail-opens beat a stuck splash.** A splash must never trap the
app: a 30 s absolute timer and a 15 s after-page-load timer both run the
handover with a log line; `render-process-gone` hands over; a closed
main window takes the splash with it (it must never be the last window
standing — `window-all-closed` would never fire); `will-quit` closes it;
macOS `activate` checks `mainWindow`, not the window count. A reload
re-sends `ready` — the one-shot handover ignores it.

**5 — E2e targets the app window, not "the first window".** The splash
is window #1, so the Playwright fixtures pick the `app://` window by URL
(scan + event loop — the `window` event fires before the URL settles),
wait for shown+focused (input dispatched in the visibility-flip-to-
mapping gap gets dropped), and a dedicated `splash.spec.ts` asserts the
splash content and the handover with its own early-watching launch.

## Consequences

- The perceived startup is now: taskbar/dark (~0.3 s, irreducible) →
  splash with live activity (~0.3–0.6 s warm; as long as the AV scan
  takes cold) → painted workspace. Warm-measured handover: ~0.6 s.
- The splash is one more thing to keep aligned with the visual system
  (its tokens are copies; a theme change must be mirrored) and its
  window a member of every "all windows" consideration (activate,
  quit, focus) — the controller keeps those call sites small.
- The renderer owns one more startup obligation: if a future feature
  delays the ready signal path (both branches in `App`'s startup
  effect), the fail-opens paper over it at +15 s — the timing marks
  (`workspace ready` line) surface it in the log instead.
- Playwright input to a just-shown window can race OS window mapping;
  the fixture's focus wait + settle is the standing workaround.

## Later change — Anthrazit colours and the logo wordmark

The splash copied the Drey (terracotta) tokens, although Anthrazit had
been the default theme since ADR-0057's later change. It now copies the
Anthrazit tokens, and both windows' `backgroundColor` follow. It does
**not** follow the user's chosen theme: it is shown before
`app-config.json` is read, and reading the config first would put work
in front of the one window whose job is to appear immediately.

The wordmark is no longer the mark above a small "drey": the mark draws
the "d" itself, so the letters "rey" stand after it on the same baseline,
sized to the mark's bowl and in the cream of the mark's outline (pure
white overpowered the dark mark) — the pair reads "drey". The element
keeps `aria-label="drey"`.
