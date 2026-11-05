# E14-9 — Decommission inventory (part a, 2026-11-05)

Scope of part (a): find the legacy ticket write paths and legacy machinery,
classify each by *when it can go*, and remove only what nothing before the
owner's verification round needs. Part (b) is the rest, after the cut-over and
the owner's round (no fixed 30 days — owner decision 2026-11-05).

Branch state inspected: `desktop-integration` at `f23f38d6` (milestone 161).

## The rule that decides everything

`tickets.backend` is `files` by default and the owner's real `drey-tickets`
runs on it until E14-7 flips it. After the flip the `files` backend is still
the **rollback**: the reverse converter (`migrate/reverse.ts`) writes a legacy
vault that only the `files` backend can run. So the `files` backend — its
readers *and* its writers — stays whole until the owner's round is over. That
makes almost the entire legacy surface class B or C by construction; what is
left for A is code that **neither backend reaches**.

Classes:

- **A** — removable now: no caller on either backend, none in the migration
  tool, `legacy-bridge`, the shadow mode or the `files` reader/writer.
- **B** — needed until the cut-over (the `files` backend is production).
- **C** — needed until after the owner's verification round (rollback,
  fallback client, reference for the migrated tickets).

Evidence is by production callers (`grep` over `packages/ plugins/ electron/
apps/`, specs excluded) on this branch; an unused-export scan of
`packages/tickets-engine` and `plugins/tickets` supplied the A candidates.
Other open branches were not scanned (see Risks).

## Class A — removable now (3 orphans, not removed)

| Item | Evidence |
|---|---|
| `parkLine()` — `core/manual-gate.ts:61` | no caller anywhere, no spec; the park wording is built inline elsewhere |
| `phaseIdFromTitle()` — `core/ticket-board.ts:361` | only its own spec cases (`ticket-board.spec.ts:435-438`); the column editor that wanted it builds ids elsewhere |
| `columnWorkerPin()` — `fleet/chain.ts:40` | only its own spec cases (`chain.spec.ts:107-112`) |

These are **not** part of the decommission: they are orphans of earlier work
that happen to sit near legacy code, none touches a ticket write path, and
together they are about 40 lines. Class A of the real decommission is
**empty**. Per the brief ("empty or tiny: say so and stop after the
inventory") nothing was removed and no test was deleted; they can ride along
with part (b) or any change that touches those files.

Also checked and **kept** (looked removable, is not):
`scripts/dricket-slice.mjs` (E14-1 scratch-store probe, referenced from
docs/06 and the migration plan — a dricket tool, not a legacy one);
`readVaultBoard` (`fleet/orchestrator.ts:870,1034`, the `files` chain's
board); `TicketChangedError` and the other "unused export" hits (used inside
their own file; only the `export` is redundant).

## Class B — needed until the cut-over (the `files` backend as production)

The write paths of the legacy format. Each is live because
`tickets.backend=files` is the default.

| # | Machinery | Where | Evidence it is live |
|---|---|---|---|
| B1 | **File writers of the board**: capture, card edit, header edits, parts release, flow save, accept / send back / archive on files | `services/board-service.ts` — 16 `this.dricket === null` / "files backend" forks; helpers at `:1953` (card write + git commit), `:2071` (move IO) | every board mutation on the default backend |
| B2 | **Phase-folder move machinery** (T-0041 numbered folders, "Number folders", reorder renumbering, archive folder + `— archived` marker) | `core/phase-dirs.ts` (123 lines; callers: `board-service`, `fleet/orchestrator.ts:34,788,1035`, `fleet/event-writer.ts:15`), `board-service.ts:4369-4472` (`numberFolders`, `renumber`) | the `files` board and chain move cards as folder moves |
| B3 | **Transition machine's file IO and the drift pass** ("a file move is a ticket move", `entered-*` stamping) | `core/transition.ts` (147; caller `board-service`), `core/normalize.ts` (203; caller `board-service` `normalizeDrift`, `:1803`) | runs on every `board` read on files. NB: `transition.ts`'s *pure patching* is also used on dricket (E14-4b), so only its file IO is legacy — part (b) must split it, not delete it |
| B4 | **Run stamps and claim stamps**: `run:` map (`pid`, `started-at`, `stream`), `claimed-by` / `claimed-at`, takeover as a file overwrite | `fleet/runs.ts:692,810,1129` (`run:` stamps), `:2245,2305,2451,2521` (ticket file writes: park, move, stamp retirement), `fleet/request.ts:315` (`claimIdentity`), `core/ticket-files.ts` | a files run stamps its ticket; on dricket the `RunLease` replaces it (`run-lease.ts`), selected by `RunRequest.dk` |
| B5 | **`.status.log` writer** | `fleet/event-writer.ts:30-111` (`statusLogPathOf`, `appendStatusLine`), `core/status-log.ts` (108) | files runs and chain write it; on a store E14-6 writes comments instead (`core/status-comment.ts`) |
| B6 | **Ledger in the ticket repository** (`tickets/_meta/ledger.jsonl`, `phase` lines, the sweep) | `core/ledger.ts:64` (`LEDGER_FILE`), `fleet/event-writer.ts`, `server/drey-port.ts:73`, `board-service.ts:3552` | the file path is shared: on a store the ledger stays at the same relative path in the **meta** vault (ADR-0090 E14-6), only `phase` lines are dropped. The path itself therefore survives; only the `files`-only writers go in (b) |
| B7 | **`FileTicketStore`** (the `TicketStore` port over legacy files) | `store/file-ticket-store.ts` (172); callers `board-service.ts` (2), `ports/ticket-store.ts` | the `files` listing and shadow mode's legacy side |
| B8 | **`core/ticket-files.ts`** (879) parse + patch of the legacy card | 13 production importers incl. `core/ticket-refine`, `plan-release`, `ticket-board`, `fleet/store-chain-board.ts`, `store/legacy-bridge.ts` | **also live on dricket**: the bridge folds a record into the legacy shape and patches it with these functions (ADR-0090 E14-4b). Not a decommission target at all — see "Not legacy" below |
| B9 | **Folder / column settings** (pipeline `push:` key, phase folders in Settings → Tickets) | `plugins/tickets/renderer/settings-columns.ts`, `settings-order.ts`, engine `settings.ts` | settings of the files pipeline; the stage vocabulary question (OD-4) is open, so the pipeline editor stays |
| B10 | **`files-guard`** (keeps the Files tree and editor off the card files) | `plugins/tickets/shared/files-guard.ts` | guards a `files` vault; a store's checkout is guarded by `routeDocuments` instead |

## Class C — needed until after the owner's verification round

| # | Item | Where | Why it outlives the flip |
|---|---|---|---|
| C1 | **Reverse converter** (rollback: dricket -> legacy vault) | `migrate/reverse.ts` | the rollback; its output is a `files` vault, so B1-B7 must still run it |
| C2 | **Legacy reader of the migration tool** and the shadow comparison | `migrate/legacy-vault.ts`, `migrate/shadow-diff.ts`, `shadow` mode in `store/store-board-source.ts` | E14-7 re-runs the migration against the frozen vault and judges it with the shadow diff. These are self-contained (they import only `contracts`, `ports`, `store/ids`, `store/flat-frontmatter`, `shared/frontmatter` — **not** `core/ticket-files`), so removing B8-adjacent code cannot break them, and they must not be touched |
| C3 | **Legacy phone remote** (the pre-Mission-Control client) | `plugins/tickets/remote/` (about 3 400 lines, built to `dist-electron/plugins/tickets/remote/` by `scripts/build-plugins.mjs:156`), `server/fallback-client.ts`, the fallback branch in `server/engine-main.ts:59`, e2e `tickets-remote.spec.ts`, `tickets-remote-repaint.spec.ts` | served only when Mission Control is not built, and kept "as the fallback until the owner verifies" (changelog, E5b hand-over). It touches no ticket file (it talks to the gateway), so it blocks nothing — but the owner's round is where Mission Control on the phone is verified, so the fallback stays until then. **Retiring it is a product decision for the owner, not a dependency one** |
| C4 | **`specs/ticket-schema.md`** (the legacy file layout) and its parts that E14-9 supersedes | `specs/ticket-schema.md`, ADR-0076 | the files rollback and the migrated-ticket read fallback are specified there; stays until (b) (brief) |
| C5 | **`pre-dricket` legacy checkout** | the owner's `drey-tickets` | read-only reference, owner's call when to delete |
| C6 | **`e2e` and specs of B/C** | `core/{phase-dirs,normalize,transition,status-log,ledger}.spec.ts`, `ticket-files.spec.ts`, runs/orchestrator files cases | go with their subjects |

## Not legacy (do not list in part (b) either)

`core/ticket-files.ts` and `ticket-board.ts` (parse, patchers, board assembly —
the dricket bridge and board assembly run on them), `core/ticket-refine.ts`,
`plan-release.ts`, `verlauf.ts`, `status-comment.ts`, `store/legacy-bridge.ts`
(it *is* the dricket write path), `core/transition.ts`'s pure part. Their name
or the word "legacy shape" in them does not make them dead; retiring the
"legacy shape" itself would be a redesign of the board's patchers and is
outside E14-9.

## Counts

| Class | Items | Lines (approx.) |
|---|---|---|
| A | 3 orphans (not part of the decommission) | ~40 |
| B | 10 (B8 is not legacy, so effectively 9) | `phase-dirs` 123 + `transition` IO + `normalize` 203 + `status-log` 108 + `file-ticket-store` 172 + the files forks in `board-service`, `runs`, `orchestrator`, `event-writer` |
| C | 6 (C1-C2 are tools, C3 about 3 400 lines of UI) | — |

## Part (b) scope — exactly this, after the owner's round

1. Remove the files forks of the board writers, folder numbering, the drift
   pass, the files half of `transition.ts` (keep the pure patchers),
   `phase-dirs.ts`, `normalize.ts` (B1-B3, B9 folder parts).
2. Remove the run/claim stamps and takeover-as-overwrite on files, the
   `.status.log` writer, the files-only ledger writers (keep the ledger path
   in the meta vault), `FileTicketStore`, `files-guard` (B4-B7, B10).
3. Remove the `files` / `shadow` modes of `tickets.backend`, the legacy reader
   and shadow diff, the reverse converter and `scripts/migrate-tickets.mjs`
   (C1, C2) — after the owner confirms no rollback is wanted.
4. Retire the legacy phone remote (C3) once Mission Control on the phone is
   verified; delete the e2e specs with it.
5. Supersede `specs/ticket-schema.md`, ADR-0076 file layout; manual (C4).

## Risks

- **Other open branches were not scanned.** Class A orphans are orphans on
  `desktop-integration`; a sibling branch (E13 views, Mission Control) could
  add a caller. Not a risk today because nothing was deleted.
- The unused-export scan misses dynamic use (string-named plugin routes) and
  cross-package `dist-electron` consumers; class B/C rely on caller evidence,
  not on the scan.
- "Class A empty" depends on keeping the `files` backend as the rollback. If
  the owner drops the rollback, C1, C2 and most of B move to "after the flip".
