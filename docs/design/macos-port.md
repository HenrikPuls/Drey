# macOS port (Intel x64) — effort analysis

Status: analysis only, no product code changed. Snapshot: branch
`desktop-integration` (Drey 0.8.1, Electron `^44.2.0`, electron-builder
`^26.15.3`, electron-updater `^6.8.9`). Everything below was read in the
repo; items I could not verify from the code are marked **(unverified)**.
Sizes: S ≤ 1 d, M 2–4 d, L 5+ d (person-days, one developer who has a
physical Intel Mac available). Package ids are working labels (`P1…`), not
roadmap ids.

## 1. Summary

Owner decision: the Mac build is for **one person, one machine** (a
MacBook Pro 2017). The **personal-use variant is the primary
recommendation**; the full release is only a "if it ever goes public"
option (§9).

| Variant | What it is | Range (person-days) | Needs |
|---|---|---|---|
| **Personal use (primary)** | ad-hoc/unsigned `.zip` (+ dmg) built on the MBP or downloaded from CI, no notarization, no Apple account, manual update by replacing the app | **8–13 d** | the owner's MBP (build + verify) |
| Full release (secondary, §9) | signed + notarized, auto-update, mac CI job, macOS e2e green, manual updated | 28–40 d (+ calendar wait for Apple enrolment) | Apple Developer account, `macos-15-intel` runner |

See §8 for the test device (Ventura constraint) before starting.

**Good news first.** Earlier work already left darwin branches in the code:
`titleBarStyle: 'hiddenInset'` (`electron/main-window.ts:105`), a native
macOS application menu (`electron/menu.ts:27-64`, installed only on darwin
at `electron/main.ts:344`), `window-all-closed` / `activate` handling
(`electron/main.ts:405,444`), an `isMac` flag that hides the custom window
buttons (`src/app/titlebar/window-chrome.service.ts:35`,
`titlebar.html:1,62`), `Cmd` printing in menus (`src/app/keybindings/command.ts:65`),
`open -a Terminal` (`electron/vault-manager.ts:350`,
`plugins/tickets/main/open-terminal.ts:46,99`), a POSIX process-group kill
in the fleet runner (`packages/tickets-engine/src/fleet/procs.ts:171-185`)
and darwin-x64 optional binaries in `package-lock.json` (`@esbuild`,
`@parcel/watcher`, `lightningcss`, `fsevents`, `@oxc-parser`). Nothing
here has ever been run on a Mac, though: all of it is **untested**.

### Five biggest cost drivers

1. **Test and CI on macOS** (P9, 4–6 d): no mac job exists, 48 e2e specs have
   never run on Darwin, and some behaviour cannot be verified without a
   physical Intel Mac.
2. **GUI-launched PATH + external binaries** (P6, 3–4 d): an app started from
   Finder/Dock gets `/usr/bin:/bin:/usr/sbin:/sbin`, so `claude`, `opencode`,
   `kimi`, `copilot`, Homebrew `git`, `dk` and `node` are not found. No PATH
   repair exists in the repo (grep for `fix-path`/login-shell: nothing).
3. **Signing, notarization, entitlements** (P2, 2–4 d + waiting): mostly
   account/credential plumbing, hard to iterate (every try = notarization
   round trip), required for auto-update.
4. **Keyboard model** (P5, 2–3 d): `Mod` = Ctrl **or** Cmd, `Alt` chords read
   `event.key` (Option produces symbols on macOS), global capture chord.
5. **The build host**: `.dmg` cannot be built on the Windows dev machine
   (needs macOS tooling), so even the first artifact requires a Mac or a
   mac CI runner; this serialises everything else.

## 2. Work packages

### P1 — Packaging for darwin x64 (M, 3 d, confidence high)

| Item | Where | Needed |
|---|---|---|
| `mac:` block (targets `dmg` + `zip`, `category`, `icon: build/icon.icns`, `hardenedRuntime`, `entitlements`, `entitlementsInherit`) | `electron-builder.yml` has only `win:`/`nsis:`/`portable:` (lines 98-115) | add; `arch: x64` |
| `.icns` icon (and cyberpunk variant) | `build/` has only `.ico`/`.png`; `extraResources` ships `icon.ico` (`electron-builder.yml:64-72`); runtime icon is `.ico` (`electron/app-paths.ts:30-37`) | generate `.icns` from `build/icon.png` (`scripts/make-icon.mjs` is the place); the Dock icon comes from the bundle, theme icon swap via `app.dock.setIcon` (new) |
| `pack` / `pack:dir` hardcode `--win` | `package.json:38-39` | add `pack:mac` (`--mac --x64`) |
| File associations | `fileAssociations` (`electron-builder.yml:80-93`) is NSIS-only by comment; electron-builder maps it to `CFBundleDocumentTypes` on mac automatically | macOS delivers files via the **`open-file` app event**, not argv: only `extractOpenPaths(process.argv)` / `second-instance` exist (`electron/main.ts:148-153`, `electron/external-open.ts`); no `open-file` handler found → add (S) |
| `asarUnpack` stdio-bridge | `electron-builder.yml:23-28` | fine as is; the bridge is spawned by an external `node` → mac users need a `node` on PATH, see P6 |
| Minimum macOS of the pinned Electron | Electron 44 | **(unverified)** — Electron dropped macOS 11 well before 44; expect macOS 12 or 13 as the floor. Check Electron's release notes before promising anything |
| universal vs x64-only | — | x64-only is what the owner asks and is smallest (no `lipo`, no 2× native binaries). It also runs on Apple-silicon Macs under Rosetta 2 (slower; Rosetta is itself scheduled to go away). A later `arm64` target is mostly a CI matrix addition because nothing in the repo is native-compiled (no `node-gyp` deps found) |
| draw.io bundle, dictionaries | `fetch-drawio.mjs` is pure Node (own zip reader, `scripts/fetch-drawio.mjs:67`); `dictionary-de/en` are asar-unpacked | platform neutral |
| Build host | electron-builder cannot create a `dmg` on Windows | build on a Mac / mac runner |

### P2 — Signing, notarization, entitlements (M, 2–4 d, confidence medium)

| Mode | What it takes | What works |
|---|---|---|
| **Unsigned / ad-hoc** (personal use) | nothing | App runs after the quarantine flag is lifted: right-click → Open on older macOS, **System Settings → Privacy & Security → "Open Anyway"** on Sequoia (15), or `xattr -dr com.apple.quarantine Drey.app` **(from memory, unverified on current macOS)**. Builds copied by USB/scp carry no quarantine at all. Keychain (P6) and auto-update (P3) do not behave well |
| **Developer ID signed + notarized** | paid Apple Developer Program membership (99 USD/yr), a "Developer ID Application" certificate, an app-specific password or App Store Connect API key for `notarytool`; secrets in GitHub Actions (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY…`) | Gatekeeper opens it without prompts, Squirrel.Mac auto-update works, Keychain item is stable across updates |
| Entitlements plist (`build/entitlements.mac.plist`) | new | at least `com.apple.security.cs.allow-jit` and `…allow-unsigned-executable-memory` (Electron/V8). Drey spawns children (`git`, CLIs, `process.execPath` as the engine) — allowed under the hardened runtime without extra keys. LAN listener (P10) needs no entitlement outside the App Sandbox. Do **not** enable the App Sandbox (the vault is an arbitrary folder, MCP/CLI spawning) → Mac App Store is out of scope |
| Nested binaries | none shipped besides Electron helpers; `dk` is not bundled (`electron-builder.yml` has no `dk` entry; configured by `store.dkPath`) | if `dk` is ever bundled it must be signed too |

### P3 — Auto-update (ADR-0074) (M, 2–3 d, confidence medium)

| Fact | Where | Change |
|---|---|---|
| Updater only constructed on Windows: `process.platform !== 'win32'` → `null` ("unsupported") | `electron/updater/update-service.ts:57-62`; creates `NsisUpdater` directly | choose `MacUpdater` on darwin (S); keep the `app.isPackaged` guard; disable when the app is not signed (detect via config flag or `codesign` check) |
| Artifacts | `publish: github` already set (`electron-builder.yml:15-18`) | mac build must publish **`.zip` + `latest-mac.yml`** next to the dmg (MacUpdater updates from the zip, not the dmg) |
| Signature requirement | Squirrel.Mac refuses unsigned updates | P2 is a hard prerequisite |
| Flow semantics | "download, install and restart always ask", quit through the exit prompt | on macOS the app stays alive with zero windows (`window-all-closed` does not quit, `main.ts:444`); verify that `quitAndInstall` still routes through the save-before-exit prompt (`MainWindowHost`) — **unverified** |
| Release workflow | `ci.yml` attaches `latest.yml` + `.blockmap` only for Windows (`ci.yml:14-19`) | add `latest-mac.yml` + zip (+ blockmap) to the same GitHub Release (S) |
| Tests | updater specs inject a fake `createUpdater` | add a darwin spec case (S) |

### P4 — Window chrome (M, 2–3 d, confidence medium; visual QA needs the Mac)

| Topic | Current state | Remaining |
|---|---|---|
| Traffic lights | `hiddenInset` on darwin; the renderer hides its own min/max/close (`titlebar.html:62`) and `.brand.mac` leaves room | check inset position vs 32 px tab bar / `--panel-head-h`, vertical centring, behaviour when the dock toggles fold; fullscreen hides lights (titlebar padding must collapse) |
| HTML menu bar (File/Edit/Selection/View) | rendered by the renderer on every platform; on darwin a **second**, native menu exists with only File/Edit/View/Window (`electron/menu.ts`) | decide: (a) keep both (duplicate menus on screen) or (b) hide the HTML bar on mac and port Selection/View/Tools rows to the native menu — recommended (b) but it means mirroring `MenuService` rows into native menu items (M). The labels use `&File` mnemonics (`menu.ts:34`), which macOS shows literally → remove `&` on darwin |
| App menu conventions | `role: 'appMenu'` only (About/Services/Hide/Quit) | add **Settings… `Cmd+,`** (opens the Settings overlay, which is renderer-owned) and a native About; `Cmd+Q` comes with the role; `Cmd+H`/`Cmd+M` fine |
| Quit semantics | closing the last window keeps the app running; `activate` re-opens (`main.ts:405`) | session restore, exit prompt for dirty tabs and the quit-on-last-window path need a pass (S) |
| Fullscreen | custom command toggling via IPC, default `F11` (`menu.ts:46-58` comment); macOS convention is `Ctrl+Cmd+F` and the green button | map the green button (native) and keep both in sync with the `fullscreen` signal (S) |
| Drag regions | `-webkit-app-region: drag/no-drag` in `titlebar.css:10,39,58,70`, `menu-bar.css:4`, `view-switcher.css:6` | fine in principle; double-click on the bar must zoom (macOS) rather than maximize — verify |
| Window `icon:` option | `icon` passed to `BrowserWindow` (`main-window.ts:97`) | ignored on macOS; harmless |
| App user model id | `main.ts:162` win32-only | nothing |

### P5 — Keybindings and global hotkey (M, 2–3 d, confidence medium-low)

| Topic | Evidence | Work |
|---|---|---|
| `Mod` semantics | `chordFromKeyPress`: `mod: ctrlKey || metaKey` (`shared/keybindings.ts:177`); `command.ts:65` prints `Cmd` on mac | works for Cmd; but **Ctrl also counts as Mod on macOS**, where `Ctrl+A/E/K/…` are Emacs-style text movements (CodeMirror's mac keymap binds them) and `Ctrl+click` is a right click. Decide whether mac should be Meta-only and test each default chord for collisions (M) |
| `Alt` chords | `chordFromKeyPress` uses `event.key` | on macOS `Option+N` yields `˜`, `Option+A` yields `å`; chords with letters/digits must be derived from `event.code` (S–M). Affects `Alt+ArrowUp/Down` (fine, non-printing) and any user-recorded `Alt+<letter>`; **unverified** which defaults use `Alt+<letter>` |
| Reserved list | `Alt+F4`, `Alt+Tab` (`keybindings.ts:73-76`) | add the macOS reserved set (`Cmd+Q`, `Cmd+H`, `Cmd+M`, `Cmd+Tab`, `Cmd+,`) |
| Docs | shortcuts help page is generated live (ADR-0067, uses `IS_MAC`) | fine; `docs/manual/manual.md` has 48 `Ctrl`/`Alt` mentions, line 1984 already says "`Ctrl` is `Cmd` on macOS" |
| Quick-capture hotkey | `globalShortcut.register` (`electron/capture-hotkey.ts:38`); default `Mod+Alt+N` (`keybindings.ts:24`) | Electron's `globalShortcut` on macOS needs **no** accessibility permission (it uses the Carbon hot-key API, **from memory/unverified**); the accelerator conversion `Mod → CommandOrControl` must be checked; `Option+letter`-only chords are restricted on newer macOS. Re-registering after the app is hidden/fullscreen needs a test on a Mac (S) |
| Menu accelerators | the native menu intentionally has no Undo/Redo (`menu.ts` comment) | on mac users expect the Edit menu to show Undo/Redo/Cmd+Z; routing issue described in that comment stays |

### P6 — Native dependencies, external programs, PATH (M, 3–4 d, confidence medium)

| Topic | Evidence | Work |
|---|---|---|
| **PATH of a Finder-launched app** | CLI providers resolve by bare name (`cli-base.ts:128,248,266-276` — "was not found on PATH"); git is `'git'` unless `gitPath` set (`plugins/git/main/index.ts:99`); `worker-models.ts:40` spawns the CLI by name; no PATH repair anywhere | resolve the user's login-shell environment once at startup (`$SHELL -ilc 'printenv PATH'`, cached) and merge it into `process.env` (also for the fleet runner/engine child, `engine-lifecycle.ts:191`); fall back to well-known dirs (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.claude/local`). M, and the single most user-visible mac failure |
| `git` | `/usr/bin/git` on a fresh Mac is a shim that pops the **Xcode Command Line Tools install dialog** (and returns an error) | detect "CLT not installed" (`xcode-select -p`) and show an English hint instead of hanging; document `brew install git` (S) |
| `dk` (dricket) | configured by `store.dkPath` (`dk-target.ts:13`, `dk-process.ts`); goreleaser provides darwin amd64 (per task brief, not re-checked) | Settings help text and default path discovery on mac; Gatekeeper quarantine of a downloaded `dk` binary (`xattr`) (S) |
| `safeStorage` | `electron/app-config.ts:40-47`; non-linux → `isEncryptionAvailable()` | on macOS it uses a Keychain item "Drey Safe Storage": first access shows a Keychain prompt; for **unsigned or differently signed builds the item's ACL no longer matches after an update/rebuild → prompt again or decrypt failure**. The app already degrades to "LostSecrets" (`app-config.ts:50`), so it is a UX issue, not data loss; signing (P2) removes it |
| chokidar | `^3.6.0`, opt-in watcher (`electron/vault-watcher.ts`); `fsevents` optional entry exists in the lock | fine; macOS FSEvents has coalescing delay and the own-write ledger (mtime matching) should be re-verified on APFS (1 ns mtime vs HFS+ 1 s) (S) |
| esbuild/vite/lightningcss/parcel-watcher | lock has `darwin-x64` variants | `npm ci` on a Mac should work; **verify once** (npm sometimes drops foreign-platform optional deps from a Windows-generated lockfile; the entries are present here, so risk is low) |
| spellcheck | nspell + bundled Hunspell, `spellcheck:false` for Chromium (`main-window.ts`) | no work |
| PDF export | `electron/pdf-export.ts` (`printToPDF`) | platform neutral; verify fonts (see P10) |
| OCR plugin | vision LLM over HTTP | neutral |
| Dictation | `plugins/tickets/main/dictation.ts:48` refuses off Windows (PowerShell/Win+H) | feature stays Windows-only; hide the button on mac (S). macOS has system-wide dictation (Fn Fn) — no integration needed |

### P7 — Process handling (fleet runner, CLI providers) (S–M, 2 d, confidence medium)

| Topic | Evidence | Work |
|---|---|---|
| Fleet runner spawn + tree kill | `procs.ts:63` `detached: !isWindows`, `shell: isWindows`; `rawKillTree` uses `process.kill(-pid,'SIGKILL')` (`:171-185`) | already POSIX-correct on paper; test on Mac (S) |
| PID reuse guard | `processStartMs` uses `ps -o lstart=` + `Date.parse` (`procs.ts:199-206`) | the BSD/mac `ps` format (`Thu Nov  6 10:00:00 2026`, local time, locale dependent) parses in V8 but is only second-granular; the 5 s tolerance (`procs.ts:136`) covers it. Verify on Mac (S) |
| Shell-timeout kill | `runs.ts:98-103` falls back to `child.kill('SIGKILL')` on POSIX — **not** a group kill, and that child was not necessarily started `detached` | use the process-group kill there too (S) |
| CLI providers (claude, copilot) | `cli-base.ts:291-296`: POSIX path is `child.kill('SIGTERM')` on the direct child only; the child is not detached → grandchildren (node, bash tools) orphan after Cancel, and SIGTERM may be ignored | spawn detached and kill `-pid`, escalate to SIGKILL (M) |
| `git` runner | `git-runner.ts:44-52` POSIX: `child.kill()` | OK for git |
| Worker CLIs (`opencode`, `kimi`) | spawned by the runner with an inherited env | covered by the PATH fix; each CLI's own darwin support is out of scope **(unverified)** |
| stdio MCP servers | `electron/mcp-client/` over the MCP SDK; commands like `npx`/`uvx` | PATH fix again; `npx` shims are plain scripts on mac (no `.cmd`) so the Windows shell workaround is simply not needed |
| Worktree links | `worktrees.ts:172` uses `'junction'` on win32, `'dir'` symlink elsewhere | already right |
| Open terminal / launch in console | darwin branches exist: `open -a Terminal` (`open-terminal.ts:46,99`); `standalone-host.ts:124` uses `open`, but `launchInConsole` on POSIX is `spawn(command,{shell:true})` with no terminal (`standalone-host.ts:135-139`) | AppleScript/`open -a Terminal` for the headless path (S) |

### P8 — IPC, CSP, custom protocols (S, 0.5–1 d, confidence medium)

`app://`, `plugin:`, `drey-asset:` are registered through `protocol.registerSchemesAsPrivileged` / `handle` (`electron/app-protocols.ts`), path-contained with `path.normalize` + prefix checks (`app-protocols.ts:92,198`). These are Chromium/Electron features, not OS features, so no change is expected. Things to verify on a Mac: the draw.io iframe over `plugin://drawio/…`, the CSP e2e (`e2e/csp.spec.ts`), the `drey-asset:` image path with spaces and NFD names (see P5/P10 for filename normalisation), and `file:` URL handling for documents (`shared/external-document.ts`; `open-document.ts:45` rejects `\\\\` UNC only — a no-op on mac, fine).

### P9 — Tests and CI (L, 4–6 d, confidence medium-low)

| Topic | Evidence | Work |
|---|---|---|
| CI is one `windows-latest` job | `.github/workflows/ci.yml` | add a `macos` job: install, lint-free subset, `test:plugins`, `test:app`, build, `pack:mac --dir`, packed-app smoke (`scripts/verify-pack.mjs`), e2e |
| **Intel runner availability** | GitHub retired `macos-13` (announced for 4 Dec 2025) and offers **`macos-15-intel`** as the Intel label until the macOS 15 image is retired in fall 2027 ([GitHub changelog](https://github.blog/changelog/2025-09-19-github-actions-macos-13-runner-image-is-closing-down/), [discussion of `macos-15-intel`](https://discuss.python.org/t/dropping-intel-mac-to-tier-2/102100/1)). Found via search; re-check `actions/runner-images` before relying on it | an Intel runner exists today but with a **finite life** (~2027): the plan should be "x64 build + test on `macos-15-intel` now; keep an arm64 runner + Rosetta fallback ready" |
| Cross-build alternative | build x64 on `macos-latest` (arm64) with `--x64`; run the app under Rosetta | cheaper long-term; the unit suites run natively on arm64 and prove nothing about x64-specific behaviour, but the app code is not native-compiled, so Rosetta e2e is a reasonable stand-in |
| Playwright/e2e | `playwright.config.ts` (Electron launch, 1 worker); 77 uses of `Control+` in 25 specs | `Control+` works because Ctrl counts as Mod, but is **not** what a Mac user presses; add `ControlOrMeta` for a handful of shortcut specs. `e2e/review-tab.spec.ts:114`, `ticket-document.spec.ts:40` contain fixture strings `Electron … on win32` (content, not logic). Expect 5–15 specs to need platform fixes (path separators, `taskkill`, titlebar width with traffic-light inset, drag-and-drop) — **unverified, estimate** |
| vitest | `electron/**/*.spec.ts` etc. inject `platform` in many places (`path-announcer.ts:42`, `ticket-documents.ts:28`), `open-terminal.spec.ts` already covers darwin | most should pass; expect failures where specs use Windows path literals or `process.platform` implicitly (`path-guard.spec.ts`, `vault-scan-rules.spec.ts`, `open-document.spec.ts`) |
| Line endings | `.gitattributes` forces `eol=lf` | no issue on Mac |
| **Cannot be verified without a physical Intel Mac** | Gatekeeper/quarantine flows with a downloaded artifact, Keychain prompt wording, traffic-light geometry, Option-key chords on a real keyboard, trackpad gestures (swipe back/forward, pinch zoom vs the editor zoom command ADR-0015), Rosetta-free performance, FSEvents latency, firewall prompt for the LAN gateway, global hotkey behaviour with fullscreen apps, Dock/menu-bar behaviour | CI can run headless e2e only |

### P10 — UX details (M, 2–3 d, confidence low-medium; mostly on-device QA)

| Topic | Notes |
|---|---|
| Fonts | font stacks are in `src/styles.css` tokens; sans chrome + mono code — check that the stacks include `-apple-system`/`SF Mono`/`Menlo` fallbacks; Windows-only families (Segoe UI, Consolas) fall through to defaults **(unverified, grep the tokens)** |
| Scrollbars | Windows classic scrollbars are probably restyled; macOS overlay scrollbars hide until scrolled — check custom `::-webkit-scrollbar` CSS |
| Context menus | the in-window menu is built in main from hit-test params (`menu.ts` second half); on macOS it should include "Look Up", Services is automatic — acceptable as is. Chromium spellcheck is off by design, so no spellcheck submenu is needed |
| Dock icon / badge | `.icns` (P1); optionally `app.dock.setBadge` for update/needs-attention |
| Notifications | `ui.notify` (req-64) uses Electron `Notification`; `setAppUserModelId` is win32-only (`main.ts:162`) — on macOS notifications work for signed apps; for unsigned builds they may not appear until allowed in System Settings **(unverified)** |
| Trackpad / gestures | pinch-to-zoom and two-finger swipe navigation: Chromium may zoom the page; check `setVisualZoomLevelLimits` and the editor-zoom command (ADR-0015) |
| Mission Control remote server | the gateway binds a LAN host (`packages/tickets-engine/src/server/gateway.ts:121`); the MCP HTTP server binds `127.0.0.1` (`electron/mcp/http-transport.ts:69`). On macOS a non-loopback listener from an unsigned app triggers "Do you want the application to accept incoming network connections?" once per binary signature (firewall) — document it; signing avoids repeats |
| `Cmd+W` / `Cmd+N` etc. | per-platform command set; see P5 |

### P11 — Documentation, manual, screenshots (S–M, 1.5–2.5 d, confidence medium)

| Item | Notes |
|---|---|
| Manual | `docs/manual/manual.md` mostly speaks `Ctrl`; line 1984 explains the Cmd mapping. Add a macOS install page (Gatekeeper workaround, CLT/git, PATH note) and "Cmd" where the text names Alt/Ctrl combinations (S) |
| Screenshots | generated by `e2e/manual-screenshots.spec.ts` on Windows, with Windows chrome (frameless titlebar buttons). No mac screenshots needed for the port; mac users get the Windows images — acceptable, state it in the manual (nothing to do). Regenerating on a Mac would show traffic lights and Cmd labels (optional, M) |
| Specs/ADRs | `docs/07_deployment_view.md` ("Windows-first"), ADR-0023 (Windows packaging) → a new ADR "macOS packaging and updates" + `docs/07` section; CLAUDE.md "Toolchain" paragraph gains a mac note; changelog entries per package (S) |

### P12 — Development on a Mac (M, 2 d, confidence high)

| Item | Evidence | Work |
|---|---|---|
| `env.ps1` (24 lines), `dev.ps1` (91 lines: bootstraps `.tools/` junction + `npm ci`, then `npm run dev`) | repo root | `dev.sh` twin; on a Mac use the system / nvm Node instead of `.tools/node` (the portable Node is a Windows binary). Worktree handling: the `.tools` **junction** is a Windows concept; the POSIX twin is a symlink or simply not needed (S) |
| `scripts/verify-dricket.ps1` (459 lines) | `scripts/` | the dk verification harness is PowerShell; either port to Node or document as Windows-only (M if ported, 0 if declared out of scope) |
| `.vscode/settings.json`, `tasks.json`, `launch.json` | `powershell.exe` terminal profiles (`settings.json:8,19`) | add `osx` profiles/`windows`-scoped tasks (S) |
| npm scripts | all `node scripts/*.mjs`, `cross-env`, `concurrently`, `wait-on` | portable; only `pack*` hardcode `--win` (P1). `scripts/stamp-build.mjs`/`clean.mjs` are Node |
| Doc rules | CLAUDE.md "no global node" is a Windows fact; fleet-worker doc (`docs/agents/fleet-worker.md`) likewise | note the POSIX variant (S) |

## 3. Platform-neutral — needs no work

Markdown/CodeMirror editor, Live Preview and the extended dialect; the tag
index, tasks, templates, backlinks, outline and assistant plugins (pure
renderer/main TypeScript); the vault tools and MCP server (loopback HTTP +
stdio bridge); LLM providers over HTTP (OpenAI-compatible, Anthropic); the
renderer CSP; frontmatter/link-rewrite logic; the tickets engine's domain
and fleet logic (already branches on `isWindows`); plugin discovery and
installer (`electron/plugin-host/*`, forward-slash normalisation present);
the `fetch:drawio` script; spellcheck dictionaries; `.gitattributes`
LF handling; the Mission Control phone/iPad web client itself (served over
HTTP, browser-side).

## 4. Case, Unicode and path details (part of P1/P6 sizing — S–M, 2–3 d)

| Finding | Evidence | Recommendation |
|---|---|---|
| Path identity is case-folded **only on win32** | `electron/external-open.ts:94`, `vault-manager.ts:963`, `vault-scan-rules.ts:40`, `plugins/git/main/discover.ts:37`, `plugins/git/main/index.ts:74`, `plugins/tickets/main/path-announcer.ts:113`, `ticket-documents.ts:120`, `packages/tickets-engine/src/fleet/worktrees.ts:531`, `migrate/apply.ts:52`, `store/dk-process.ts:312` | default macOS APFS is **case-insensitive** (volumes may be case-sensitive): the same folder reached as `/Users/x/Notes` vs `/users/x/notes` compares unequal → duplicate vaults, a missed "outside the vault" check, a missed allowlist hit. Make the fold a runtime probe of the volume (or fold on darwin too). The own-write ledger already lower-cases always (`own-write-ledger.ts:123`) |
| **Unicode normalisation** | no `.normalize('NFC')` for file names in main (only `NFKD` slugging in `chat-note.ts:761`, `meeting/slug.ts:36`) | German note names (`ä ö ü`): macOS tools (Finder, `git` with `core.precomposeunicode` unset) can store NFD names while a typed `[[Übersicht]]` is NFC → wikilink resolution and link rewrite miss. Normalise to NFC at the name comparison points (M); **unverified how many sites** |
| Backslash handling | many `.replace(/\\/g,'/')` in `electron/mcp/tools/*` | harmless on POSIX (no-ops) |
| OneDrive / long paths | no OneDrive-specific code found (comments only); long-path guard is win32-only (`migrate/apply.ts:42`) | none (iCloud Drive/OneDrive on Mac: online-only placeholders ("dataless files") can make reads slow — **unverified**, watch for it) |
| Per-user data | `app.getPath('userData')` everywhere | resolves to `~/Library/Application Support/drey`; nothing hardcoded found (`USERPROFILE`/`APPDATA` grep: none in non-spec code) |
| Reveal / open | `shell.openPath` allowlist (`shared/external-document.ts`); Finder reveal via Electron `showItemInFolder` | works on mac; Office files open in the default app |
| Drag & drop of Office files | `Alt`-drop links the original instead of copying (ADR-0066) | on macOS the modifier is **Option**; `altKey` is the same flag, but Finder's own Option-drag semantics and the drag image should be tried (S) |

## 5. Sizing table

| Pkg | Topic | Size | Days | Confidence | In MVP |
|---|---|---|---|---|---|
| P1 | Packaging darwin x64, icns, dmg/zip, `open-file` | M | 3 (2–4) | high | yes (2 d: dmg+zip, icon, `open-file` optional) |
| P2 | Signing, notarization, entitlements | M | 3 (2–4) + wait | medium | no |
| P3 | Auto-update on macOS | M | 2.5 (2–3) | medium | no |
| P4 | Window chrome / menus | M | 2.5 (2–3) | medium | partly (1–2 d: app menu, mnemonics, fullscreen) |
| P5 | Keybindings, Option chords, global hotkey | M | 2.5 (2–3) | medium-low | partly (1 d: Option chords, collision check) |
| P6 | PATH, git/CLT, dk, Keychain, native deps | M | 3.5 (3–4) | medium | partly (1.5–2 d: PATH + git hint) |
| P7 | Process kill/cancel, headless console | S–M | 2 (1–2) | medium | partly (0.5 d: CLI Cancel) |
| P8 | IPC/CSP/protocols | S | 0.7 (0.5–1) | medium | yes (verify) |
| P9 | Tests, CI, Intel runner | L | 5 (4–6) | medium-low | minimal (1 d: run suites locally, fix breakages) |
| P10 | UX details, on-device QA | M | 2.5 (2–3) | low-medium | smoke only (0.5 d) |
| P11 | Docs/manual | S–M | 2 (1.5–2.5) | medium | 0.5 d |
| P12 | Dev tooling for Mac | M | 2 (2) | high | 1 d (`dev.sh`) |
| §4 | Case/NFC/path folding | S–M | 2.5 (2–3) | medium | yes (1 d: case probe, NFC at link resolution) |
| | **Total** | | **≈ 33 (28–40)** | | **MVP ≈ 8–13** |

(MVP column adds to 8–13: P1 2 + P4 1.5 + P5 1 + P6 2 + P7 0.5 + P8 0.5 + P9 1 + P10 0.5 + P11 0.5 + P12 1 + §4 1 ≈ 11.5, lower bound if the first Mac QA round finds little.) The totals are strongly driven by findings **on a real Mac**; add ~25 % contingency for the first full e2e run.

## 6. Top risks

1. No Mac testing available → defects found late (all darwin branches are untested).
2. PATH/Finder-launch problem makes AI features and git look "broken" (P6).
3. Notarization/Developer-ID lead time and credential handling; auto-update impossible without it.
4. Intel is a dying target: Intel runner ends ~2027, Rosetta 2 goes away; x64-only artifact has a short shelf life — decide on an arm64/universal follow-up before investing in the signing pipeline.
5. Keychain re-prompts / secret loss on unsigned rebuilds (P6).
6. NFD file names and case-insensitive volumes corrupt link resolution silently (§4).
7. Electron minimum macOS: Electron 44 needs macOS 13 (verified by search, §9) — fine for the MBP on Ventura, but a later Electron major that drops 13 strands it.

## 7. Recommended order (proposed roadmap items; ids assigned by the owner)

| # | Item | Packages | Why this position |
|---|---|---|---|
| 1 | Dev on Mac + first unsigned build | P12, P1 (dmg/zip/icns) | unblocks everything; proves the app starts |
| 2 | Finder-launch PATH + git/CLT hint | P6 | biggest functional gap |
| 3 | Path identity: case probe + NFC | §4 | silent data-correctness risk |
| 4 | Chrome + keys: app menu, Option chords, fullscreen, hotkey | P4, P5 | daily usability |
| 5 | Process cancel/kill parity | P7 | worker/CLI orphans |
| 6 | macOS CI job (Intel runner), e2e fixes | P9 | regression protection before more work |
| 7 | Signing + notarization | P2 | needs the Apple account |
| 8 | Auto-update + release workflow | P3 | needs 7 |
| 9 | UX sweep + manual + ADR | P10, P11 | after the above is stable |
| — | optional: arm64/universal build, drop Rosetta reliance | — | decision input from risk 4 |

### Minimum viable vs full

| | MVP (personal, unsigned) | Full |
|---|---|---|
| Artifact | `.dmg` / `.zip`, built on the owner's Mac (`npm run pack:mac`) | CI-built, signed, notarized dmg + zip + `latest-mac.yml` |
| Install | quarantine workaround documented | double-click |
| Update | manual: replace the app | in-app (ADR-0074) |
| Secrets | Keychain prompts possible after rebuilds | stable |
| Tests | local vitest + a handful of e2e | mac CI job gating releases |
| Effort | 8–13 d | 28–40 d |

## 8. Open questions for the owner

1. ANSWERED: an Intel MacBook Pro 2017 is the test device (§9). STILL OPEN: exact model and installed macOS (assumed Ventura 13; Apple menu → About This Mac).
2. Apple Developer Program account: not needed for the personal-use variant (owner: personal use only); still unknown, only relevant for §11.
3. ANSWERED (likely): Ventura 13 only, one machine; the Electron upgrade path ends when an Electron major drops macOS 13 (§9).
4. Is **x64-only** acceptable, or should an arm64/universal build follow (Intel is on a clock)?
5. Menu strategy on mac: hide the HTML menu bar and use the native menu (recommended), or keep the cross-platform HTML bar?
6. Should `Ctrl` keep acting as `Mod` on macOS (today's behaviour), or Cmd only?
7. Should the Windows-only features (dictation via Win+H, PowerShell verification harness) simply stay Windows-only?
8. Should the fleet/tickets features (CLI workers, `dk`) be in scope for mac at all, or is the first mac release "notes only"? (Cuts P6/P7 by roughly 3 d.)

## 9. Test device: MacBook Pro 2017 (Intel, ≤ macOS 13)

The owner has a MacBook Pro from about 2017 (exact model unknown). A
2017 MacBook Pro is supported by macOS Ventura (13) and not by anything
newer, so the working assumption is **Intel x64, macOS 13.x at most**
(the owner expects Ventura; confirm via Apple menu → About This Mac —
**unverified**).

| Question | Finding | Consequence |
|---|---|---|
| Electron minimum macOS | Electron 38–43 require macOS 12+; **Electron 44 raised the floor to macOS 13** (Monterey dropped, because Chromium dropped it); Electron 45 is also reported as macOS 13+ (secondary source). Chrome 150 is the last Chromium-based Chrome for macOS 12, Chrome 151 the first to require 13+ ([Electron breaking changes](https://www.electronjs.org/docs/latest/breaking-changes), [6529-core Electron 44 plan](https://github.com/6529-Collections/6529-core/issues/266), [MacRumors on Chrome 150](https://www.macrumors.com/2026/01/12/google-chrome-150-last-version-support-macos-12/)) | Drey's pinned `^44.2.0` **runs on Ventura**. Ventura is the floor for 44 and 45; **which Electron major is the last to support macOS 13 is not yet published** — Chromium usually drops an OS about two years after Apple's release cadence suggests, so expect the cut within the next few majors (**estimate, unverified**). Plan: pin Electron to a major that still supports 13, and treat the drop of macOS 13 as the end of the Mac port's upgrade path (the MBP stays on its last supported Electron while Windows moves on). Check each Electron major's breaking-changes entry before upgrading |
| electron-updater floor | the update feed compares a minimum system version against the Darwin kernel (macOS 13 = Darwin 22) | irrelevant for personal use; relevant to §10 |
| Node / Angular / vitest / Playwright | none of them is native-compiled in this repo; Angular CLI, esbuild, vite, vitest are JS plus prebuilt binaries (`@esbuild/darwin-x64` etc. are in the lockfile). **Node 24 on macOS 13** — Node's supported-platform list names macOS 13.5+ for current majors **(from memory, unverified)**. Playwright drives the Electron app, not Playwright's own WebKit, so the OS floor is Electron's | no native-module risk; verify `npm ci` + `npm run build` once on the MBP |
| Dev toolchain on that Mac | Node via nvm or `brew install node@24` (Homebrew on an Intel Mac under Ventura is a supported tier but gets less binary-bottle coverage as macOS ages, so some formulae build from source) | `dev.sh` (P12) uses whatever `node` is on PATH |
| Xcode command line tools | on Ventura install the CLT matching Ventura (Xcode 14.x; Xcode 15.x CLT need 13.5+, and one report says a 2017 MBP topped out at 13.6.6 and could not take the Xcode that required Sonoma) ([Apple forum thread](https://developer.apple.com/forums/thread/750210)). **Bundled git version not found** — run `git --version` after `xcode-select --install` | `/usr/bin/git` is Apple Git (2.3x-2.4x class, **unverified**); Drey needs a normal modern git; Homebrew `git` is the fallback and then PATH (P6) matters |
| CI | build/test x64 on `macos-15-intel` (finite life, see P9) or arm64 runner + Rosetta; the macOS 15 runner image can target `MACOSX_DEPLOYMENT_TARGET`/Electron's own minimum | CI proves the x64 build and unit/e2e behaviour; the **MBP stays the manual test device** for Gatekeeper, Keychain, traffic lights, Option keys, trackpad, firewall prompt, Ventura-specific behaviour |
| Still unknown | exact macOS version/model on the MBP; Apple Developer account (not needed for personal use) | open questions below |

## 10. Updating an unsigned app, and Gatekeeper (personal use)

| Question | Answer |
|---|---|
| Can an unsigned app auto-update? | **No in practice.** `electron-updater`'s macOS path (Squirrel.Mac) validates the code signature of the new bundle against the running one; an unsigned build fails, and an ad-hoc signature differs on every build. Keep the updater `unsupported` on macOS for this variant (the existing gate in `electron/updater/update-service.ts:57-62` already does that — **no code change** needed for personal use) |
| Pragmatic update path | build on the MBP (`npm run pack:mac`) or download the `.zip` from the CI release/artifact, quit Drey, replace `/Applications/Drey.app`, then clear quarantine: `xattr -cr /Applications/Drey.app` (a file copied via USB/scp/`gh` CLI carries no quarantine; a Safari/Chrome download does) |
| Gatekeeper on first start | right-click → Open (Ventura still offers this for unsigned apps; Sequoia removed it in favour of System Settings → Privacy & Security → Open Anyway) or `xattr -cr` |
| Ad-hoc signing | electron-builder ad-hoc signs by default on macOS when no identity is configured (`codesign --sign -`), which is needed for Apple-silicon, harmless on Intel; **each rebuild is a new identity**, so the Keychain "Drey Safe Storage" item prompts again — click "Always Allow", or accept re-entering API keys (the app already handles lost secrets) |
| What personal use skips | notarization, Developer ID, entitlements fine-tuning (default hardened-runtime off is fine), `latest-mac.yml`, P3, most of P2 |

## 11. If it ever goes public (short)

Add: Apple Developer Program (99 USD/yr), Developer ID signing +
notarization with entitlements (P2, 2–4 d), `MacUpdater` + zip +
`latest-mac.yml` in the release (P3, 2–3 d), the macOS CI job as a release
gate (P9), manual/ADR (P11), and re-decide x64-only versus
arm64/universal (Intel runner ends ~2027). Delta over the personal
variant: roughly **+17–27 days** (total 28–40 d).
