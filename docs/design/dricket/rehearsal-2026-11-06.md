# Cut-over rehearsal — 2026-11-06 (E14-7, steps B and C on a copy)

Rehearsed end to end on a copy of the owner's real `drey-tickets` vault, stopping
before any change to the real data. dk v0.6.2, branch `desktop-integration` plus
the fixes listed under "Code changes" (milestone 169). The original was only read
(`git status` and HEAD identical before and after; the isolated profile's
`-Reset` reported the real `~/.drey-engine` and userData fingerprint unchanged,
345 files).

**Verdict: ready for the real cut-over**, with the conditions at the end. No
blocker is left in the tool; two things have to be decided or done by the owner
(stale run stamp, uncommitted files in `drey-tickets`).

## 1. The source

`E:\projects\drey-tickets`, `main`, HEAD `c72d250` ("tickets: T-0017 inbox ->
prioritized"), copied with `robocopy /E /XD _worktrees` — **the working tree, not
`git clone`**: the vault has uncommitted state (3 modified archive files,
untracked `tickets/_meta/ledger.jsonl`, `tickets/10-inbox/attachments/`,
`tickets/videos/`) and a clone would silently lose it. `origin` was removed from
the copy.

| Folder | Files |
|---|---|
| `10-inbox` | 23 |
| `20-prioritized` | 2 (T-0017, T-0091) |
| `50-build`, `60-commit`, `80-done` | 0 (empty; done tickets are archived) |
| `archive/` | 66 (T-0001 … T-0087 without the open ones) |
| total | 91 tickets, ids T-0001 … T-0091 |

- **Run stamps:** T-0030 (inbox; `run: pid 27872`, started 2026-11-04T13:12Z, an
  interactive refine dialog; the pid is dead) and T-0050 (archive, pid 49864,
  2026-10-30). Both block the apply until `--allow-live-runs`.
- **Claims** (`claimed-by` / `claimed-at`): T-0002, T-0004, T-0005, T-0006 (all
  archived, stale since 2026-10-17).
- **Worktrees:** `_worktrees/T-0030` and `_worktrees/T-0091` exist (branches
  `t/T-…`); they are not part of the migration and are not copied.
- **Pins:** `_meta/order.md` lists pins for inbox and prioritized; pins are retired
  (req-75 W1) and not migrated — the order is derived (priority, `x-rank`, id) on
  both sides, the shadow report confirms the same column order.

## 2. The allow list — and what to do with done / archived tickets

The non-done tickets are the 25 files outside `archive/`
(`Get-ChildItem tickets -Recurse -Filter 'T-*.md'` minus `archive`). The owner's
done tickets are **not** in a `done` folder: accepting a ticket moves it to
`archive/`, so "done" means the 66 archive files.

Until this rehearsal the migration skipped `archive/` for good (OD-7). Measured
with the archive included (as `stage: done` + label `archived`, the label the
board already treats as "off the board", E14-4b):

| | 25 tickets | 91 tickets (archive included) |
|---|---|---|
| apply (incl. validate + shadow) | 20 s quiet, 114 s under load | 44–102 s |
| `dk validate` | 12.7 s | 19–32 s |
| `dk ls` | 1.2 s | 0.6 s |
| board from the checkout (91 files) | — | 20–45 ms |
| new warnings | — | none that matter (see §3) |

**Recommendation: migrate them.** Reasons: the owner wants to read old tickets
(roadmap E13-21) and `dk show` / `dk search` / the ticket document open them with
no second system; ids stay contiguous (next new ticket is `t-92`, checked), so no
placeholders and no gap; `blocked-by` links into done tickets stay real
(T-0017 -> T-0049 becomes `depends: t-49` instead of a dropped link plus
`x-legacy-blocked-by` plus a migration comment). The cost is about 30 s more per
run and an archive that every `dk ls` lists (the board filters the label, so the
columns stay as before; 66 archived rows are 0.6 s). Without the label the same
tickets would fill the Done column (91 cards instead of 25, checked) — the label
is what keeps the board quiet.

Implemented as `--include-archive` (default off, OD-7 stays the default): each
archive file becomes `stage: <terminal stage>` + `labels: archived`,
`x-legacy-phase: archive`; the reverse converter writes a ticket carrying the
label back into `tickets/archive/`. Keeping them readable "another way" (the old
repo as the archive) works too — it is the backup anyway — but then every link
from a live ticket to a done one is dropped and the owner reads two systems.

## 3. Migration run

Dry run 2.6 s. Apply into a fresh store (`E:\dkr12`), then `dk validate`:
**clean**, in every variant (25 tickets; 91 tickets with and without the label).
Warnings and fallbacks, every one of them:

| Ticket | What | Class |
|---|---|---|
| T-0030 (inbox) | `run:` stamp present, not carried, blocks apply without `--allow-live-runs` | owner action: the stamp is stale (pid dead, dialog from 2026-11-04). Before the real run: check the pid is dead, then `--allow-live-runs`, or clear the `run:` block in the frozen vault |
| T-0050 (archive) | same | same (pid 49864, 2026-10-30) |
| T-0002, 4, 5, 6 (archive) | `claimed-by` / `claimed-at` not carried | expected (live state of done tickets) |
| T-0017 | `blocked-by T-0049`: with the archive in the set it migrates (`depends: t-49`); without it, dropped, kept in `x-legacy-blocked-by`, one comment on the ticket | expected |
| T-0054 | 5 attachment links rewritten `../attachments/` -> `attachments/` | data quirk: they are code examples (`img-test.png`) in a ticket about image tests; nothing real is missing. The two real attachment images stay in the old repo |
| T-0084 | no creator (no Log line): the migrating identity is used | data quirk |
| T-0084 | **file unreadable** ("no front matter fence") | **tool bug, fixed**: the working copy has a UTF-8 byte order mark (an editor on Windows added it, with CRLF); the reader now strips it |
| T-0085 | title 234 characters, shortened to 200 with `…`, the full title leads the description | expected, now declared in the shadow diff |
| all | no creation data missing: `created_at` from the first `entered-*`, `created_by` from the first Log line (T-0084 aside); no placeholders; numbers are real (t-10 … t-91) | — |

Fallback tickets with no creation data: none except T-0084 (creator only).

## 4. Shadow run in the running app

Isolated profile via `scripts/verify-dricket.ps1 -NoLaunch`, then the profile's
`vault-config.json` -> a second copy of the vault (`activeVaultPath`) and the
tickets plugin config -> `backend: shadow`, `dk.store: <copy of the new store>`.
Started the production build; the report `<profile>\home\.drey-engine\shadow\
board-diff.md` appears 1-2 s after the window is up.

| Store | Report | Classification |
|---|---|---|
| 25 tickets, no archive | 24 identical, 1 differs: T-0017 `meta.blockedBy: T-0049 -> ''` | expected (dropped dangling blocker, declared) |
| 91 tickets, archive **without** label | 25 left, 25 right, same T-0017 line | see the finding below (it was the previous store's report) |
| 91 tickets, archive with label | 25 left, 91 right, 66 only in dricket — again the previous store's report | see below |
| 91 tickets, archive with label, **second start** | **Identical: 25 tickets, same columns, same order** | — |

**Finding (reader/engine, not fixed, roadmap):** after changing `backend` /
`dk.store` in the plugin config the **first start still reports the previous
store**: the engine reads its own `config.json`, the app mirrors the plugin
config into it only after the first board snapshot, and nothing triggers a new
snapshot afterwards (the report stayed unchanged for 3 minutes). It looks like a
real wrong answer, so for the cut-over: start twice (or trigger a board refresh)
and **read the `Generated` stamp and the ticket counts in the report header**
before believing "identical". Probed to be sure: `assembleBoardFromRecords` over
the three stores gives 25 / 91 / 25 cards — the code is right, the settings
arrive late.

Classification of every difference seen: migration bug 0; reader bug 0 (the
late settings are an engine start-up ordering issue); expected 2 (dangling
blocker, archive cards when unlabelled); data quirk 1 (T-0084 BOM) — fixed.

## 5. Round trip (rollback proof)

`--reverse --store <new store> --out <fresh dir>` from the 25-ticket store, then
a semantic compare with the copied original (ticket set, folder, parsed header,
body, byte for byte; the title's YAML quoting style differs only):

- 25 of 25 tickets: same set, same phases, same titles, same bodies, same
  headers except **T-0030's `run:` stamp** (declared: live state is never
  carried).
- First run found two real gaps, both **fixed**: (a) the reverse dropped
  `x-legacy-blocked-by` (T-0017 lost its `blocked-by: T-0049`); (b) the reverse CLI
  passed **no comments** to the converter, so every comment written on dricket
  after the flip was lost on rollback, silently (the guide promised otherwise).
  `dk` cannot list comments, so the CLI now reads the `comments/` files of a local
  store's ticket branch and appends them to the `## Log` (one line each, oldest
  first); a remote store prints that comments are not carried.
- With the archive (91 tickets, `--include-archive`): 91 of 91 back, archive
  files in `tickets/archive/`; differences are all declared kinds: the two `run:`
  stamps, the claims of four done tickets, the 5 rewritten attachment links
  (T-0054) and the shortened title of T-0085 (full title stays in its body).
- Folder numbers: the reverse numbers by stage position (`30-build`, `40-commit`,
  `50-done`), the legacy vault has `50-build`, `60-commit`, `80-done`. The board
  strips the prefix, so it reads either; the tool writes into a fresh directory, so
  there is no clash. Low risk; to keep the old numbers pass them in code
  (`phaseDirs`) — no CLI flag yet.

## 6. Timing

| Step | Time |
|---|---|
| copy of the vault (robocopy, 72 MB without worktrees) | 0.6 s |
| dry run | 2.6 s |
| apply 25 tickets (create + validate + shadow diff) | 20 s (quiet), 114 s (while a production build ran) |
| apply 91 tickets | 44–102 s |
| `dk validate` 25 / 91 tickets | 12.7 s / 19–32 s |
| `dk ls` | 0.6–1.2 s |
| board load from the checkout, 91 tickets | 20–45 ms (a `dk show` per ticket would be ~30 s) |
| shadow report after app start | 1–2 s after the window is up (app start 2–20 s, load dependent) |
| reverse 25 / 91 tickets | 23 s / 48 s (one `dk show` per ticket) |

The machine ran other sessions' builds and tests throughout; the spread is load,
not the tool.

## 7. Stages under the new default pipeline (E12-9c, not merged yet)

Current mapping (this branch): legacy phase = stage id; defaults
`inbox prioritized build commit done`, `claim` = `build`, `commit`; the legacy
vault has exactly these phases, so nothing is renamed.

Under the E12-9c default (`inbox plan build review sign-off done`, branch
`claude/e12-9c-default-pipeline-7a7849`, its `DEFAULT_MIGRATION_CONFIG.legacyPhases`):

| Legacy | New stage | Note |
|---|---|---|
| `inbox` | `inbox` | |
| `prioritized` | `inbox` | T-0017 and T-0091 fall back to Inbox; the old phase stays in `x-legacy-phase`. Plan would hand them to the planner when the chain runs, so Inbox is the safe choice — the owner re-triages |
| `build` | `build` | |
| `commit` | `sign-off` | the owner checkpoint |
| `done` | `done` | |
| `archive` (with `--include-archive`) | `done` + label `archived` | this rehearsal's addition; independent of the stage names |

That branch changes the same files as the fixes here (`convert.ts`, `reverse.ts`,
`cli.ts`, `shadow-diff.ts`, their specs); expect a textual merge, the changes are
independent (`includeArchive` is an optional config field). Do the real cut-over
**after both are merged**, so the store is created with the stage names the app
will ship with; changing a store's stages later means editing `dricket.toml` and
every ticket.

## 8. Gaps in the guide, corrected in `cutover-guide.md`

- Paths were corrupted (`.\scriptserify-dricket.ps1`, `plugins<TAB>ickets`).
- Copy step said "copy the folder" — now the exact `robocopy` (working tree, no
  `_worktrees`, drop `origin`).
- No word on **uncommitted files** in `drey-tickets` and on the **`pre-dricket`
  tag** (ADR-0090 / migration plan §4) — added to the freeze.
- Freeze said "stop the fleet/chain" — the **engine is a detached daemon** that
  outlives Drey (`engine.lock`), so quitting Drey does not stop it, and it keeps
  the old settings; now: quit Drey, stop the engine pid, check the run stamps.
- Exact commands, the stale-run-stamp procedure, `--include-archive`, the real
  keys and where the file is.
- The shadow report's late settings (§4) and what "identical" has to show.
- Rollback levels 2 and 3 spelled out; comments now come back.

## 9. Code changes (milestone 169)

- `legacy-vault.ts`: byte order mark stripped before the fence check (T-0084 was
  unreadable). Test.
- `cli.ts`: `--report` into a drive root (`E:\report.md`) failed with `EPERM, mkdir
  'E:\'`; the directory is only created when missing. `--include-archive`.
  `--reverse` reads the store's comments.
- `reverse-comments.ts` (new): comments of a local store's ticket branch. Spec.
- `reverse.ts`: restores `x-legacy-blocked-by` / `x-legacy-parent`; a ticket with
  the `archived` label goes to `tickets/archive/` and its label is not "lost".
- `convert.ts`: `includeArchive`. `shadow-diff.ts`: archived rows and a shortened
  title are declared differences instead of noise.

## 10. Commands for the real run

Prerequisites: this work merged with `desktop-integration` (and E12-9c), `dk`
v0.6.2+ on PATH, the owner's git identity set, Drey **closed**, the engine
stopped, `E:\dkm` (store), `E:\dkm-data` (dk data) not existing yet.

```powershell
cd <checkout with the merged branch>
. .\env.ps1
npm run build:plugins

# 1. freeze: see the guide (engine stopped, no run stamps, drey-tickets committed and tagged)
# 2. copy for the dry run, allow list = every ticket file
robocopy E:\projects\drey-tickets E:\dkc /E /XD _worktrees /NFL /NDL /NJH /NJS /NP
git -C E:\dkc remote remove origin
Get-ChildItem E:\dkc\tickets -Recurse -File -Filter 'T-*.md' | % { $_.BaseName } | sort | Set-Content E:\dkc-allow.txt
node scripts/migrate-tickets.mjs --legacy E:\dkc --allow E:\dkc-allow.txt --include-archive

# 3. apply (against the frozen real vault, read only; add --allow-live-runs only after checking the pids)
node scripts/migrate-tickets.mjs --legacy E:\projects\drey-tickets --allow E:\dkc-allow.txt --include-archive --apply --store E:\dkm --dk (Get-Command dk).Source --actor owner@legion --data E:\dkm-data --report E:\dkm-report.md
```

Rollback proof before the flip (optional, 25-90 s):
`node scripts/migrate-tickets.mjs --reverse --store E:\dkm --dk (Get-Command dk).Source --data E:\dkm-data --out E:\dkm-back`.

## 11. Conditions / what the owner decides

1. Commit (or knowingly leave out) the uncommitted files of `drey-tickets` before
   the freeze — the migration reads the working tree, the `pre-dricket` tag marks
   a commit.
2. T-0030's `run:` stamp is stale; confirm no runner is alive, then
   `--allow-live-runs`.
3. Archive: migrate (recommended) or not — one flag.
4. Merge order: this branch, E12-9c, then the real run.
5. Read the shadow report's header, not only its verdict (§4).

## 12. Cleanup done

Isolated profile and scratch store removed with `verify-dricket.ps1 -Reset`
(only marker-bearing folders). Scratch folders created by this rehearsal, all
under `E:\` (`dkr*`, `dkr-*`): left in place where the sandbox refused the
delete (`Remove-Item` on `E:\dkr1`); list in the hand-over note; none is inside
OneDrive, none holds anything but copies.
