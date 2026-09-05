# 11. Risks and Technical Debt

Carried over from `specs/roadmap.md` ("Open Risks / Undecided Details"),
tracked here so they stay visible as the app is built:

| Risk | Notes | Status |
|---|---|---|
| Autosave-vs-watcher conflict | Concrete UX not yet defined (diff view? conflict copy? undo?). Roadmap only commits to a minimum: surface as a warning with "keep mine / take external version". | Open — deferred by design at milestone 3: the editor uses **explicit save (Ctrl+S) + a dirty indicator**, not autosave, and there is no file watcher yet, so the two don't interact. Switching a dirty buffer to another file prompts via `confirm()` (the stated minimum). Revisit when the watcher lands. |
| Model contention | Classifier/embeddings vs. benchmarking models sharing LM Studio (RTX 4080, 12GB VRAM) — needs an availability check before every call. | Open — relevant from milestone 6 (LM Studio client) onward. |
| Folder sprawl from LLM suggestions | Inbox review acts as a brake, but no guarantee against near-duplicate tags (e.g. "sailing" vs. "boat"). | Open — relevant from milestone 7 (batch tag suggestion) onward. |
| Tag registry scaling | Prompt 2's registry is fine under ~50 tags; a much larger vault would need pre-filtering instead of the full list in-prompt. | Noted, not an MVP concern (`specs/classifier-spec.md`, "Scaling note"). |
| Structured-output enforcement | Small local models sometimes ignore "JSON only" prompt instructions. Should use LM Studio's `response_format` JSON-schema/grammar constraining if the chosen model supports it — unverified so far. | Open — needs a check before milestone 6 relies on unconstrained JSON parsing. |

## Spec deviations

| Deviation | Notes | Since |
|---|---|---|
| Quick-capture opens the daily note, not a popup | `specs/roadmap.md` (Phase 1) specifies a **global hotkey + popup window** with its own input, submitting to the inbox. Changed in review by the project owner: the hotkey now raises the main window and opens today's `daily/YYYY-MM-DD.md` in the editor. See [ADR-0002](09_architecture_decisions/0002-quick-capture-opens-daily-note.md). **`specs/roadmap.md` still describes the old model** — update it, or record the popup as explicitly dropped. | Milestone 4 |
| "Daily note" as a per-day file | New concept. The roadmap only has "daily tasks" (inline `#task` + a read-only day view built by timestamp scanning) — not an Obsidian-style daily note. Introduced as the quick-capture target. | Milestone 4 |
| `templates/` folder in Phase 1 | New concept for Phase 1 (templates otherwise appear only in Phase 4 interview mode). `templates/daily.md` seeds new daily notes; the substitution mechanism (`electron/daily-note.ts`) is meant to be reused for milestone 5 file creation. Tag-routing (milestone 5) must exclude `daily/` and `templates/` from folder proposals. | Milestone 4 |
| Main process writes files the user didn't create | First hotkey press in a fresh vault materialises `daily/`, `daily/<date>.md`, and `templates/daily.md`. Visible in the sidebar, but worth knowing it's not purely read-until-asked. | Milestone 4 |

## Technical debt

| Item | Notes | Since |
|---|---|---|
| Preload runs without the OS-level Electron sandbox (`sandbox: false`) | `contextIsolation: true` and `nodeIntegration: false` are still on (the two properties ADR-0001 commits to), but the extra process sandbox is off because a sandboxed preload's `require()` can't load `shared/ipc-api.js`. Fix: give preload its own bundling step (e.g. esbuild) that inlines `shared/` into one file with no runtime `require()`, then re-enable. | Milestone 1 |
| No feedback when the hotkey fires with no vault selected | `openTodayDailyNote` raises the window and logs a warning; the only user-visible cue is the sidebar's "no vault" state. A renderer toast would be better. | Milestone 4 |
| Hotkey vs. a dirty non-daily buffer | If another file is open with unsaved changes, the hotkey's `openFile` shows the milestone-3 `confirm()`; declining leaves you where you were with no daily note opened. Acceptable until the real conflict UX lands with the file watcher. | Milestone 4 |

## Environment gotchas worth remembering

| Gotcha | Notes |
|---|---|
| `ELECTRON_RUN_AS_NODE` can leak from the parent shell | Some parent processes (e.g. an Electron-based host application's integrated terminal) already have this env var set, sometimes to an empty string. Electron only checks whether the key *exists*, not its value, so this silently makes `electron .` run as plain Node instead of bootstrapping the app (`require('electron')` resolves to the npm package's path-string helper; `app.whenReady` is `undefined`). Worked around in `scripts/run-electron.js`, which explicitly deletes the key before spawning Electron — do the same in any other place that spawns Electron directly. |
| `npm`'s install-scripts allowlist blocks Electron's own binary download | `node_modules/electron`'s postinstall (which fetches the actual `electron.exe`) doesn't run under npm's newer script-allowlist gate. Worked around with an explicit `postinstall` script in the project's own `package.json` (`node node_modules/electron/install.js`, idempotent) — that one always runs, since the allowlist only gates *dependency* scripts, not the root project's own. |
| `app.getPath('userData')` is keyed only by app *name*, not by project path | Electron derives the userData folder (`%APPDATA%\<name>\` on Windows) purely from `package.json`'s `"name"` field. Any other Electron app on the same machine that happens to use the same name reads/writes the same folder — including `vault-manager.ts`'s `vault-config.json`. Confirmed harmless so far (this machine has no other app named `drey`), but worth remembering if that ever changes: rename via `package.json`'s `"name"` (and, once electron-builder is configured for packaging, its `appId`) to something more collision-resistant if this becomes a real concern. |
| VS Code tasks/debug launches don't inherit `env.ps1`'s PATH | Each task/debug session spawns its own shell that never sources `env.ps1`, so a naive `npm run ...` task or a `runtimeExecutable` pointing at `node_modules/.bin/electron(.cmd)` fails to find `node`/`npm` (that shim falls back to a bare `node` on PATH when no `node.exe` sits next to it). Worked around three ways, see `.vscode/`: `tasks.json` has a top-level `options.env.PATH` prepending `.tools/node`; the Electron debug configs in `launch.json` point `runtimeExecutable` straight at `.tools/node/node.exe` with `program` set to `node_modules/electron/cli.js` (no PATH dependency at all); `settings.json` gives the integrated terminal a default profile that sources `env.ps1` on open, for anything typed by hand. |
