# 11. Risks and Technical Debt

Carried over from `specs/roadmap.md` ("Open Risks / Undecided Details"),
tracked here so they stay visible as the app is built:

| Risk | Notes | Status |
|---|---|---|
| Autosave-vs-watcher conflict | Concrete UX not yet defined (diff view? conflict copy? undo?). Roadmap only commits to a minimum: surface as a warning with "keep mine / take external version". | Open — needs a decision before file-watcher + editor autosave interact (milestone 3/2). |
| Model contention | Classifier/embeddings vs. benchmarking models sharing LM Studio (RTX 4080, 12GB VRAM) — needs an availability check before every call. | Open — relevant from milestone 6 (LM Studio client) onward. |
| Folder sprawl from LLM suggestions | Inbox review acts as a brake, but no guarantee against near-duplicate tags (e.g. "sailing" vs. "boat"). | Open — relevant from milestone 7 (batch tag suggestion) onward. |
| Tag registry scaling | Prompt 2's registry is fine under ~50 tags; a much larger vault would need pre-filtering instead of the full list in-prompt. | Noted, not an MVP concern (`specs/classifier-spec.md`, "Scaling note"). |
| Structured-output enforcement | Small local models sometimes ignore "JSON only" prompt instructions. Should use LM Studio's `response_format` JSON-schema/grammar constraining if the chosen model supports it — unverified so far. | Open — needs a check before milestone 6 relies on unconstrained JSON parsing. |

## Technical debt

| Item | Notes | Since |
|---|---|---|
| Preload runs without the OS-level Electron sandbox (`sandbox: false`) | `contextIsolation: true` and `nodeIntegration: false` are still on (the two properties ADR-0001 commits to), but the extra process sandbox is off because a sandboxed preload's `require()` can't load `shared/ipc-api.js`. Fix: give preload its own bundling step (e.g. esbuild) that inlines `shared/` into one file with no runtime `require()`, then re-enable. | Milestone 1 |

## Environment gotchas worth remembering

| Gotcha | Notes |
|---|---|
| `ELECTRON_RUN_AS_NODE` can leak from the parent shell | Some parent processes (e.g. an Electron-based host application's integrated terminal) already have this env var set, sometimes to an empty string. Electron only checks whether the key *exists*, not its value, so this silently makes `electron .` run as plain Node instead of bootstrapping the app (`require('electron')` resolves to the npm package's path-string helper; `app.whenReady` is `undefined`). Worked around in `scripts/run-electron.js`, which explicitly deletes the key before spawning Electron — do the same in any other place that spawns Electron directly. |
| `npm`'s install-scripts allowlist blocks Electron's own binary download | `node_modules/electron`'s postinstall (which fetches the actual `electron.exe`) doesn't run under npm's newer script-allowlist gate. Worked around with an explicit `postinstall` script in the project's own `package.json` (`node node_modules/electron/install.js`, idempotent) — that one always runs, since the allowlist only gates *dependency* scripts, not the root project's own. |
| `app.getPath('userData')` is keyed only by app *name*, not by project path | Electron derives the userData folder (`%APPDATA%\<name>\` on Windows) purely from `package.json`'s `"name"` field. Any other Electron app on the same machine that happens to use the same name reads/writes the same folder — including `vault-manager.ts`'s `vault-config.json`. Confirmed harmless so far (this machine has no other app named `cybernotes`), but worth remembering if that ever changes: rename via `package.json`'s `"name"` (and, once electron-builder is configured for packaging, its `appId`) to something more collision-resistant if this becomes a real concern. |
