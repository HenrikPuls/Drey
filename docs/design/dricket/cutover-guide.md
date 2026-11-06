# Owner guide — verification round and cut-over to dricket

Status 2026-11-06 (corrected after the rehearsal on a copy of the real vault:
`rehearsal-2026-11-06.md`; since E14-7a every start reads the settings the first time).
For the owner: what to check in the running app (milestones 154–161 are all "Not yet
manually verified"), and how the cut-over (E14-7) goes. Nothing here touches the real
`drey-tickets` repository until step C.

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

   *Archive: settled, it migrates.* The owner's O-3 (2026-11-06) is "all tickets migrate once",
   which replaces OD-7, and the rehearsal recommends the same. `--include-archive` writes each
   archive file as a `done` ticket with the label `archived`. The label keeps it off the board
   (the columns look as before) while `dk ls`, `dk show`, search and the ticket document read
   it, links from live tickets to done ones stay valid and the numbers stay contiguous. It costs
   about 30 s per run. **The flag is required:** without it the 66 archive files are skipped and
   the tool still exits 0, so check that the dry run's first line says `0 skipped`.
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
   the files with real numbers and creation data (no placeholders), then runs `dk validate` and
   the shadow diff itself. It exits non-zero on an incomplete apply or a failed validate; **a
   shadow difference only prints**, so read the two lines `dk validate: clean` and
   `shadow diff: identical`:

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
   `%USERPROFILE%\.drey-engine\shadow\` in your own Drey). One start is enough when the engine
   was stopped first: the app writes the settings into the engine's `config.json` before it
   starts the engine (E14-7a, the rehearsal's §4 finding). Expect `Identical`, and check the
   `Generated` time: an engine left running can skip a run for up to 30 s after its last one,
   and the report does not name the store. The only expected difference is a `blocked-by` into
   a done ticket that is *not* in the allow list.

## C. The cut-over (E14-7) — one start, with you present

The one step that touches the real data. All tickets migrate once, with the six states written
once (O-2, O-3, decision 27): the store's stages are never renamed afterwards. Run it top to
bottom in **PowerShell 7** (`pwsh`; Windows PowerShell 5 writes a byte order mark into JSON) from
a checkout of `desktop-integration`. Every step says what it should show; stop at the first one
that shows something else, nothing is lost before step 7.

Time: about 15 minutes, mostly the two production builds (`.\dev.ps1 -Built` builds fresh on every start).

**Before you begin**

- Merged into `desktop-integration`: **req-99a** (the six stages in the migration config and the
  engine, `--pipeline-out`; session W2.2) and **E14-7a** (this guide). Without req-99a the store is
  created with the old stage names and `--pipeline-out` is refused, so stop.
- A is clean, and **B was repeated after that merge**: the rehearsal of 2026-11-06 ran on the old
  stage names, so this sequence has not yet run with the six.
- The stage ids (`packages/tickets-engine/src/core/pipeline-states.ts`, from req-99a; the migration
  writes them without a flag, and `dricket.toml` gets `claim = ["building"]`):

  | State | Stage id | From the legacy phase |
  |---|---|---|
  | Inbox | `inbox` | `inbox` (23 tickets today) |
  | Shaping | `shaping` | `plan` (0) |
  | Prioritized | `prioritized` | `prioritized` (2) |
  | Building | `building` | `build` (0) |
  | Ready to try | `ready` | `review`, `sign-off`, `commit` (0) |
  | Done | `done` | `done` (0), and `archive` (66) with the label `archived` |

  Any other phase is skipped with a reason in the dry run, never guessed.

Set the names once. They are used by every step below, so stay in this one terminal:

```powershell
$legacy = 'E:\projects\drey-tickets'
$store  = 'E:\projects\drey-board'        # OD-5; must not exist yet
$data   = 'E:\projects\drey-board-data'
$allow  = 'E:\projects\drey-board-allow.txt'
$report = 'E:\projects\drey-board-report.md'
$pipeline = 'E:\projects\drey-board-pipeline.md'
$dk     = (Get-Command dk).Source
$plugin = "$env:APPDATA\drey\plugins\tickets\config.json"
function Stop-DreyEngine {
  $lock = "$env:USERPROFILE\.drey-engine\engine.lock"
  if (Test-Path $lock) { Stop-Process -Id (Get-Content $lock -Raw | ConvertFrom-Json).pid -ErrorAction SilentlyContinue }
}
function Set-TicketsConfig([hashtable] $values) {
  $config = Get-Content $plugin -Raw | ConvertFrom-Json
  foreach ($key in $values.Keys) { $config | Add-Member -Force -NotePropertyName $key -NotePropertyValue $values[$key] }
  $config | ConvertTo-Json -Depth 20 | Set-Content $plugin
}
. .\env.ps1
npm run build:plugins
```

Run `npm ci` first if `package-lock.json` changed since your last install.

**1. Freeze.** Quit Drey and every other Drey instance, make no moves from the phone, and do not
start a chain until step 8 is done. Then stop the engine: it is a detached daemon that outlives
Drey. End any `opencode` or runner process started for a ticket.

```powershell
Stop-DreyEngine
git -C $legacy status --short
```

Commit what the migration reads, because it reads the working tree and the tag marks a commit.
On 2026-11-06 that was three modified archive files. Look at them first. The rest stays where it
is, since this repository stays on disk as the meta vault:

```powershell
git -C $legacy diff --stat -- tickets/archive
git -C $legacy add tickets/archive
git -C $legacy commit -m "tickets: state before the dricket cut-over"
git -C $legacy tag pre-dricket
```

This repository is also your backup, so never delete it.

**2. Fresh allow list.** Every ticket file in the frozen vault, written now and not reused from
anywhere (`migrate-allow-list.txt` is the retired 22-ticket triage):

```powershell
Get-ChildItem "$legacy\tickets" -Recurse -File -Filter 'T-*.md' | ForEach-Object { $_.BaseName } | Sort-Object | Set-Content $allow
(Get-Content $allow).Count
```

Shows the number of ticket files (91 on 2026-11-06).

**3. Dry run.** Reads the vault only, 3 s. It also writes the six-state pipeline for step 7 to
`$pipeline`, outside the vault:

```powershell
node scripts/migrate-tickets.mjs --legacy $legacy --allow $allow --include-archive --pipeline-out $pipeline | Tee-Object "$report.dry.txt" | Select-String 'DRY RUN|BLOCKS APPLY|pipeline'
```

Shows `DRY RUN: <n> to migrate, 0 skipped`, with `<n>` the count from step 2. `pipeline: not
carried:` lines name what the new pipeline drops: expect the agent `commit` column's budget and
persona, since Ready to try is the owner's checkpoint. Each `BLOCKS APPLY` line is a ticket with a
`run:` stamp. Open `"$report.dry.txt"` to see which: on 2026-11-06 T-0030 (pid 27872) and T-0050
(pid 49864). Check that no such process is alive:

```powershell
Select-String -Path "$legacy\tickets\*\T-*.md" -Pattern '^\s*pid:' | ForEach-Object { $_.Line.Trim() + '  ' + $_.Filename }
Get-Process -Id 27872, 49864 -ErrorAction SilentlyContinue
```

The second command must print nothing. The stamps are stale and are never carried to the store;
`--allow-live-runs` below is your statement that you checked. Use the pids the first command
printed if they differ.

**4. Final import into a fresh store.** Under 2 minutes for about 90 tickets. The legacy vault is
only read:

```powershell
node scripts/migrate-tickets.mjs --legacy $legacy --allow $allow --include-archive --apply --allow-live-runs --store $store --dk $dk --actor owner@legion --data $data --report $report
```

Exits 0. Read the last lines: `dk validate: clean` and `shadow diff: identical, <n> declared`.
**The exit code does not cover the shadow diff**, so a line that says `<n> difference(s)` is a
stop: see the `Shadow diff` part of `$report`. This is the comparison of record, because it maps
each legacy phase to its new stage and so holds across the rename.

**5. Check the store on its own.**

```powershell
git -C $store show main:dricket.toml | Select-String 'values|claim|terminal'
$env:DK_STORE = $store; $env:DK_OWNER = 'owner@legion'; $env:DK_DATA_DIR = $data
& $dk validate
(& $dk ls | Measure-Object -Line).Lines
```

The `[stages]` line lists the six ids from the table, in that order, and `claim` is `["building"]`.
`dk validate` is clean. The `ls` count equals the ticket count from step 2.

**6. Shadow in the app.** One start. The UI still shows the files board and nothing is written to
the store. This checks the app's reader over the new store; step 4 already compared the content:

```powershell
Set-TicketsConfig @{ 'backend' = 'shadow'; 'dk.store' = $store; 'dk.dataDir' = $data }
Remove-Item "$env:USERPROFILE\.drey-engine\shadow\board-diff.md" -ErrorAction SilentlyContinue
.\dev.ps1 -Built
```

When the window is up (the report appears 1-2 s later), in a second terminal:

```powershell
Get-Content "$env:USERPROFILE\.drey-engine\shadow\board-diff.md" -TotalCount 6
```

`Generated` is now and the verdict is `**Identical**: <n> tickets on both sides`, with `<n>` the
tickets outside the archive (25 on 2026-11-06). The app wrote the new settings into the engine's
`config.json` before it started the engine, so this describes the new store on the first start
(E14-7a).

Identical is only possible while every live ticket stands in a phase whose id did not change
(`inbox`, `prioritized`, `done`), which is true today. This report reads one pipeline for both sides,
so it cannot match across the rename: a ticket in `build` or `commit` at the freeze shows a `phase`
difference. Such a line is expected when step 4 was clean. Anything else is a stop.

Then quit Drey and stop the engine:

```powershell
Stop-DreyEngine
```

**7. Flip.** This is the switch; after it the board comes from the store.

The columns come from `tickets/_meta/pipeline.md` in the meta vault, not from the store, and a
stage that is not a phase there shows as an unknown column. The file still lists `inbox,
prioritized, build, commit, done`, so the converted one from step 3 goes in with the flip. The
tool never writes the vault, so this copy is the one write:

```powershell
Copy-Item $pipeline "$legacy\tickets\_meta\pipeline.md"
git -C $legacy diff --stat -- tickets/_meta/pipeline.md
git -C $legacy add tickets/_meta/pipeline.md
git -C $legacy commit -m "pipeline: the six states (dricket cut-over)"
Set-TicketsConfig @{ 'backend' = 'dricket' }
.\dev.ps1 -Built
```

**8. Smoke.** The same start, no second one. Use a second terminal, since the first one is held by the running app:

- the board shows the same tickets as before, in the six columns, and no unknown column;
- one move, one priority change;
- open a ticket document (asks once to add the checkout as a vault), edit, Ctrl+S;
- one comment;
- one short fleet run on a throw-away ticket: claim, extend and release show in `dk show`;
- Accept on that ticket in Ready to try: the commit step runs, and with Drey open the ticket lands
  in Done (while the step holds its claim, dk shows the ticket in Building);
- an old ticket opens: `dk show t-49`.

```powershell
git -C E:\projects\drey-board log --oneline -10
```

Each action above is one `dricket: ...` commit.

**9. Your round.** Use the app for real work for as long as you want; there is no fixed period
(owner, 2026-11-05). Requirements go to `specs/roadmap.md`, not into hand edits of the store.
When you are satisfied, E14-9b deletes the legacy code (scope in
`docs/design/dricket/decommission.md`).

**Rollback** stays possible until E14-9b:

- *Before step 7:* quit Drey, `Stop-DreyEngine`, `Set-TicketsConfig @{ 'backend' = 'files' }`,
  start. Write `files` explicitly: the app does not push a key the plugin config no longer holds,
  so deleting the key would leave the engine on the store. The legacy vault was not modified, apart
  from the commit and the tag of step 1.
- *After step 7, before anything was written on dricket:* the same, plus the old pipeline back:
  `git -C $legacy checkout pre-dricket -- tickets/_meta/pipeline.md`, then commit it.
- *After work on dricket:* write the legacy layout from the store:

  ```powershell
  node scripts/migrate-tickets.mjs --reverse --store $store --dk $dk --data $data --out "$store-back"
  ```

  Archived tickets go into `tickets/archive/`, comments become Log lines, and new tickets keep their
  ids above the old maximum. The output folders are the legacy columns (`inbox, prioritized, build,
  commit, done`, the default of `--stages`), numbered by position, which the board ignores. Make a
  **fresh clone** of `drey-tickets`, replace its `tickets/<phase>/` and `tickets/archive/` ticket
  files with the output, restore the old pipeline there (`git checkout pre-dricket --
  tickets/_meta/pipeline.md`), review `git diff`, commit, and point Drey at it with
  `"backend": "files"`. Not carried back: labels, `touches`, claim leases, run stamps.

## Known gaps (not blockers for A–C)

No answer button for Needs-you in the UI (route and engine method exist); a worker
cannot edit its own ticket chapters on a store (`## Handover`); no "release leftover
claims" button (runs automatically at start); chain on a remote store does not
`dk sync` by itself (the engine's feed does); no real run with a real worker was
made on a second instance; the shadow report does not name the store it compared, and
an engine left running can skip a run for up to 30 s after its last one (stopping the
engine avoids both, step 6); the reverse converter has no flag for the legacy folder
numbers; a commit step only settles into Done while a client is fetching the board
(req-99a hand-over: one line in `server/engine.ts`, open). Full list: `specs/roadmap.md`, E14-5c, E14-6 and E14-7 follow-ups.
