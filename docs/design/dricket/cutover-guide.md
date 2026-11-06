# Owner guide — verification round and cut-over to dricket

Status 2026-11-06 (corrected after the rehearsal on a copy of the real vault:
`rehearsal-2026-11-06.md`). For the owner: what to check in the running app
(milestones 154–161 are all "Not yet manually verified"), and how the cut-over
(E14-7) goes. Nothing here touches the real `drey-tickets` repository until step C.

Requirements: `dk` v0.6.2 or newer on PATH (or `tickets.dk.path`), the build of
`desktop-integration` (`.\dev.ps1 -Built` — always a fresh production build, no
DevTools), git with your identity set. Keep every store and data folder on a
**short path** (about 150 characters at most) and **outside OneDrive**.

## A. Verification round on a scratch store (no risk)

One command does steps 1-3 (needs `dk` on PATH, or `-DkPath`):

```powershell
.\scripts\verify-dricket.ps1            # scratch store E:\dkv + isolated profile E:\dkv-profile, builds, starts the app
.\scripts\verify-dricket.ps1 -Remote    # the store is a bare repo + a separate clone (periodic dk sync)
.\scripts\verify-dricket.ps1 -Reset     # stop app + engine, delete only what the script created
```

Options: `-Store`, `-Profile` (short paths, at most 150 characters, outside OneDrive; the
script refuses anything else and refuses a non-empty folder it did not create), `-SkipBuild`
(reuse `dist/`), `-NoLaunch` (prepare only), `-Fingerprint` (print the real-data fingerprint).
It seeds six English tickets: stages inbox / prioritized / build / commit / done, one with a
comment (t-1), one blocked by another (t-3 depends on t-2), one claimed by a foreign runner
with a lease that ended hours ago (t-4). It prints the checklist below with the paths filled in
and writes `<profile>\dk-env.ps1` for the second terminal (`DK_STORE`, `DK_OWNER`, git identity).

How the isolation works (verified): the app is started with `USERPROFILE`, `HOME`, `APPDATA`,
`LOCALAPPDATA` and `--user-data-dir` all inside the profile. The engine home is
`<USERPROFILE>\.drey-engine`, so the real `~/.drey-engine` (and its lock) is never seen; the
plugin config, the vault registry and the session are `<userData>\...`, so the real settings
are never seen. The engine and the board still want a tickets vault to host
(`tickets/_meta/pipeline.md`), so the profile carries a tiny one; the board content itself comes
from the dricket store. **No `-Multi` and no closing of your normal Drey is needed**: the
single-instance lock belongs to the userData folder, and the script sets
`DREY_MULTI_INSTANCE=1` anyway (a second instance only loses the quick-capture hotkey).
Before the start the script fingerprints the real `~/.drey-engine` and real userData config
files; `-Reset` compares and reports any difference (your own running Drey writes its logs,
that is the only expected source). The rehearsal checked this: unchanged.

Do not pipe the script into `Select-Object -First n`: the pipeline stops the script before
the launch line.

Manual equivalent, if you want to do it by hand: `dk init <dir> t`, add a `[stages]` table to
`dricket.toml` on `main` *before* adding tickets (Drey's phases are the stage ids), and write
`<userData>\plugins\tickets\config.json` (flat JSON; `<userData>` is `%APPDATA%\drey`):
`"backend": "dricket"`, `"dk.store": "E:\\dkv"` (no UI yet for these two). Optional:
`"dk.checkout"` (empty = the store folder itself), `"dk.syncSeconds"` (remote stores only,
default 30), `"dk.path"`, `"dk.dataDir"`. Settings -> Tickets shows checkout and sync seconds.

4. Check, in this order:
   - the board (Work tab, or the Tickets panel) shows the scratch tickets; a `dk add` /
     `dk put` from a terminal appears within about 1-2 s (watcher) without refresh;
   - the board's own moves: capture, priority, stage move, accept / send back - each
     is one `dricket: put ...` commit (`git -C E:\dkv log --oneline`);
   - open a ticket document in the editor, edit, Ctrl+S - a `put` commit; edit the
     same ticket from a terminal in between: the save conflict merge view opens;
   - a ticket's comments (`dk comment t-1 -m "x"`) show in the thread; a Needs-you
     decision resolves via a comment (there is **no answer button yet**);
   - one fleet run on a throw-away ticket (the profile has **no worker configured**; set
     one in Settings first): claim, extend, release visible in `dk show`; kill the runner
     (Task Manager) and start the script again - the leftover claim is released at start; a
     *foreign* dead claim (t-4) is taken over only after lease end **plus dk's fixed
     20-minute grace**;
   - Source control marks the checkout "Managed by Tickets".
5. Anything wrong: note it as a requirement (ids in `specs/roadmap.md`), do not
   fix by hand-editing the store.

Seen while verifying the script: the Tickets panel footer still says "The tickets vault is not
a git repository - transitions are not versioned" on a dricket board (the legacy files-backend
hint; the store is the git repository), and the board shows t-4 (expired foreign claim) under
"Running / Queued". Note both if they bother you.

## B. Rehearsal on a copy of the real vault (no risk to the real one)

Done once by Claude on 2026-11-06 — numbers, warnings and findings in
`rehearsal-2026-11-06.md`. Repeat it before the cut-over if the vault changed a lot.
Use your own short paths below (`E:\dkc` copy, `E:\dkm` store, `E:\dkm-data` dk data).

1. **Copy the working tree** (not `git clone`: the vault has uncommitted state, a clone
   loses it; `_worktrees/` are the agent worktrees and not needed), and cut the copy off
   from the real remote:

   ```powershell
   robocopy E:\projects\drey-tickets E:\dkc /E /XD _worktrees /NFL /NDL /NJH /NJS /NP
   git -C E:\dkc remote remove origin
   ```
2. **Allow list.** The migration only touches the ids it is given. Your done tickets are the
   files in `tickets/archive/` (accepting a ticket archives it; `80-done` is empty), so the
   list is *every* ticket file when the archive is migrated (recommended, see below):

   ```powershell
   Get-ChildItem E:\dkc\tickets -Recurse -File -Filter 'T-*.md' | % { $_.BaseName } | sort | Set-Content E:\dkc-allow.txt
   ```

   *Archive:* `--include-archive` migrates `archive/` too, each as a `done` ticket with the label
   `archived`. The label keeps it off the board (the columns look as before) while `dk ls`,
   `dk show`, search and the ticket document read it, links from live tickets to done ones stay
   valid and the numbers stay contiguous. It costs about 30 s per run. Without the flag the
   archive is skipped (OD-7: the old repo is the archive) and links into it are dropped.
3. **Dry run** (read only, 3 s), read the report:

   ```powershell
   npm run build:plugins
   node scripts/migrate-tickets.mjs --legacy E:\dkc --allow E:\dkc-allow.txt --include-archive
   ```

   A ticket with a **run stamp** (`run:` in its header; the rehearsal found T-0030 and
   T-0050, both dead) blocks the apply. Check that the pid is dead
   (`Get-Process -Id <pid>`), then add `--allow-live-runs` — or delete the stale `run:` block
   from the frozen vault yourself first. The stamp is never carried to the store.
4. **Apply** into a fresh store (the folder must not exist or be empty; the tool refuses the
   legacy vault itself, a folder inside it, and a store that already has tickets). It writes
   the files with real numbers and creation data (no placeholders), runs `dk validate` and the
   shadow diff itself, and exits non-zero if either fails:

   ```powershell
   node scripts/migrate-tickets.mjs --legacy E:\dkc --allow E:\dkc-allow.txt --include-archive --apply --allow-live-runs `
     --store E:\dkm --dk (Get-Command dk).Source --actor owner@legion --data E:\dkm-data --report E:\dkm-report.md
   ```

   `--actor` becomes the store's admin (`dricket.toml`). 1-2 minutes for about 90 tickets.
5. **Rollback proof** (optional, under a minute): `node scripts/migrate-tickets.mjs --reverse
   --store E:\dkm --dk (Get-Command dk).Source --data E:\dkm-data --out E:\dkm-back` writes a
   legacy vault from the store; compare it with `E:\dkc` (same tickets, phases, titles,
   bodies; declared differences only: run stamps, stale claims). Comments written on dricket
   come back as lines in the ticket's `## Log`.
6. **Shadow in the app.** Use the isolated profile (`verify-dricket.ps1 -NoLaunch`, then edit
   `<profile>\userData\vault-config.json` -> `{"activeVaultPath": "<a second copy of the
   vault>"}` and `<profile>\userData\plugins\tickets\config.json` -> `"backend": "shadow"`,
   `"dk.store": "<a copy of E:\dkm>"`, then start it without `-NoLaunch`), or your own Drey.
   The UI keeps showing the files board; the report is
   `<engine home>\shadow\board-diff.md` (`<profile>\home\.drey-engine\shadow\` in the profile,
   `%USERPROFILE%\.drey-engine\shadow\` in your own Drey). **Read the header, not only the
   verdict:** the first start after changing `backend` / `dk.store` can still report the
   *previous* store (the engine learns the new settings after its first snapshot; see the
   rehearsal, §4). Start twice, check the `Generated` time and the ticket counts (left =
   files board, right = store board) and expect `Identical`. The only expected difference is
   a `blocked-by` into a done ticket that is *not* in the allow list.

## C. The cut-over (E14-7) — your decision, the one step that touches the real data

Only after A and B are clean, and after the branch fixes of the rehearsal (BOM reader,
reverse comments, `--include-archive`) and the E12-9c default pipeline are merged: the store is
created with the stage names the app will ship with.

1. **Freeze.**
   - Quit Drey **and stop the engine**: the engine is a detached daemon that outlives Drey and
     keeps the old settings. `%USERPROFILE%\.drey-engine\engine.lock` names its pid
     (`Stop-Process -Id <pid>`); end any `opencode` / runner processes started for a ticket.
     Close other Drey instances. Do not start a chain until the flip is done.
   - No `run:` stamp may be live (step B.3 shows them); no ticket may be mid-move.
   - **Commit what you want kept** in `drey-tickets` (`git status`: the migration reads the
     working tree, the tag marks a commit; the rehearsal vault had 3 modified archive files and
     untracked `ledger.jsonl`, attachments, videos).
   - Tag the legacy state: `git -C E:\projects\drey-tickets tag pre-dricket`. This repository
     is also your backup — never delete it.
2. **Final import.** The step B commands against the real, frozen vault: a fresh dry-run copy
   is not needed any more, `--legacy E:\projects\drey-tickets` is only read. Fresh allow list,
   **fresh store folder** (the apply refuses a store that already has tickets), `dk validate`
   clean (the command prints it, the report keeps it). Keep the report.
3. **Shadow once more** against the real vault and the new store (step B.6, own Drey or
   isolated profile with a copy of the real vault): `Identical`, counts equal.
4. **Flip.** In `%APPDATA%\drey\plugins\tickets\config.json` set `"backend": "dricket"` and
   `"dk.store": "E:\\dkm"` (optional `"dk.dataDir"`), start Drey (twice if the first board
   still looks like the old one, see B.6). Smoke: the board shows the same tickets as before,
   one move, one editor save, one comment, one short fleet run on a throw-away ticket
   (`git -C E:\dkm log --oneline` shows each as a `dricket: ...` commit).
5. **Rollback** stays possible until E14-9b:
   - *Within the freeze, before anything was written on dricket:* quit Drey, stop the engine,
     set `"backend": "files"` (or delete the key), start. The legacy vault was not modified
     (apart from your `pre-dricket` tag).
   - *After work on dricket:* `node scripts/migrate-tickets.mjs --reverse --store E:\dkm --dk
     (Get-Command dk).Source --data E:\dkm-data --out E:\dkm-back` writes the legacy layout
     (archived tickets into `tickets/archive/`, comments as Log lines, new tickets with their
     ids above the old maximum). Make a **fresh clone** of `drey-tickets`, replace its
     `tickets/<phase>/` and `tickets/archive/` ticket files with the output, review `git diff`,
     commit, point Drey at it with `"backend": "files"`. The reverse numbers the folders by
     position (`30-build`, `40-commit`, `50-done`); the board ignores the numbers.
     Not carried back: labels, `touches`, claim leases, run stamps.
6. After your round is satisfied, E14-9b (decommission, scope in
   `docs/design/dricket/decommission.md`) deletes the legacy code.

## Known gaps (not blockers for A–C)

No answer button for Needs-you in the UI (route and engine method exist); a worker
cannot edit its own ticket chapters on a store (`## Handover`); no "release leftover
claims" button (runs automatically at start); chain on a remote store does not
`dk sync` by itself (the engine's feed does); no real run with a real worker was
made on a second instance; the engine reports the previous store until its second
snapshot after a settings change (rehearsal §4); the reverse converter has no flag for
the legacy folder numbers. Full list: `specs/roadmap.md`, E14-5c and E14-6
follow-ups.
