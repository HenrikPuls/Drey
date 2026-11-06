# Tickets on dricket — engine impact

Status: analysis, proposed. Read [`fit-analysis.md`](fit-analysis.md) first;
module names below are those of the tree at `desktop-integration` (milestone
143). "Inferred" marks statements I did not verify in the module's source.

Verdicts: **REPLACED** (the module's job is done by `dk`; delete after the
cut-over), **ADAPTED** (kept, internals change), **UNCHANGED**, **DELETED**
(job disappears), **NEW**.

## 1. The seam: a `TicketStore` port

Today the engine reaches ticket data through three things at once: the
`EngineHost` file API (`read`, `write`, `listMarkdownFiles`,
`announceChanges`), the git helper `core/tickets-git.ts` (one commit queue per
repo) and the `TransitionIo` of the transition machine. The runner
(`fleet/event-writer.ts`, `fleet/runs.ts`) additionally reads and writes the
vault with plain `fs`.

The migration introduces one narrow port in `packages/tickets-engine/src/ports/`:

```ts
interface TicketStore {
  list(filter): Promise<TicketRecord[]>           // header fields + extension keys
  read(id): Promise<{ text: string; rev: number; epoch: number; owner: string | null; leaseUntil: string | null }>
  create(doc): Promise<{ id: string }>
  put(id, text, ifRev): Promise<{ rev: number }>   // whole-ticket write
  setFields(id, fields, ifRev): Promise<{ rev: number }>
  move(id, stage, ifRev): Promise<{ rev: number }>
  claim(id, owner, size, kind): Promise<Claim>
  extend(id, reason): Promise<Claim>
  release(id, stage, message): Promise<void>
  comment(id, text): Promise<{ file: string }>
  comments(id): Promise<Comment[]>
  history(id): Promise<StageChange[]>
  changes(sinceCursor): Promise<{ cursor: string; ids: string[] }>
}
```

Two implementations behind one config key (`tickets.backend`: `files` |
`dricket`): `FileTicketStore` (today's behaviour, wrapped; no new logic) and
`DricketTicketStore` (spawns `dk ... --json`, maps exit codes to the
engine's existing `MutationResult` errors). Ids cross the port in Drey's
**display form** (`T-0063`); the dricket implementation maps to `t-63`
(`fit-analysis.md` 2.1). Mission Control, the remote protocol and the DTOs
therefore keep seeing `T-0063`.

This is the adapter seam that keeps Mission Control usable during the
cut-over (`migration-plan.md` §6): the engine can serve the legacy board and a
dricket board side by side from the same port.

## 2. `packages/tickets-engine`

### 2.1 `core/`

| Module | Today | Verdict | Change |
|---|---|---|---|
| `ticket-files.ts` (874) | YAML front-matter parse/patch, header edits (`patchTicketFile`, `withLogLine`, claim stamping), issues | **ADAPTED** | The parser becomes a **flat dricket reader** (`key: value`, comma lists, raw timestamps). Patching of header fields goes through `setFields`/`put`; the Log-line helper (`withLogLine`) is **DELETED** (dricket logs). The parse side keeps reading all Drey keys as extension keys. Reading must tolerate titles with `:` (valid flat, invalid YAML). |
| `ticket-board.ts` (911) | board assembly from `_meta` + files; derived order; columns from phase folders | **ADAPTED** | Input changes from "files per phase folder" to `TicketRecord[]` with `stage` (or `x-phase`). Column membership, derived order, jump classes, derived `blocked`/`blocks` stay. Archive column logic goes (`done` + label). The `yaml` import stays for `_meta` files only. |
| `transition.ts` (147) — "THE one transition machine" | read -> patch -> rename -> write -> one commit -> push -> announce | **REPLACED** | A transition becomes `store.move()` / `store.release()`; the machine's `TransitionIo` (`renameInto`, `commit`, `push`) has no counterpart. `TransitionSpec` shrinks to (id, to, actor, message, extra fields). Keep the *pure* guard parts (lane rules, claim stamping decisions) in `core/`. |
| `tickets-git.ts` (203) | `execFile git`, per-repo commit queue, `index.lock` retry | **DELETED** for ticket writes | `dk` has its own file lock and CAS. Still needed for the *meta* repo (personas, prompts, chat commits), so it stays but is no longer used on the ticket path. |
| `normalize.ts` (203), `phase-dirs.ts` (123) | drift pass; phase folder naming/numbering | **DELETED** | Stages cannot be moved by moving files; `dk validate` reports direct writes. |
| `commands.ts` (550) | parsers for board commands | **UNCHANGED** | Payload validation of the remote commands; `claim` command semantics narrow (see §2.4). |
| `blocked.ts`, `chain-delta.ts`, `flow-edit.ts`, `plan-parts.ts`, `plan-delta.ts`, `plan-release.ts`, `plan-section.ts`, `proof-mode.ts`, `scout.ts`, `verification.ts`, `verlauf.ts`, `review-feedback.ts`, `estimate.ts` | domain parsers/writers over *body text and header keys* | **UNCHANGED** (pure) | They take and return strings; only their callers change. `blocked.ts` reads `depends` instead of `blocked-by`; the dangling-id rule decides whether it needs a flag ([R-12]). `plan-release.ts` needs the batch semantics of §2.3. |
| `ledger.ts` (194), `status-log.ts` | `_meta/ledger.jsonl`, `<id>.status.log` parsers/renderers | **ADAPTED** | Ledger keeps its line format; `phase` events are dropped (derivable). Status log: parser reads comment bodies by verb; renderer produces comment text. See §5. |
| `persona.ts`, `improvements.ts`, `chat-*.ts`, `model-prices.ts`, `default-prompts.ts`, `manual-gate.ts`, `persona-thread.ts` | persona/chat domain | **UNCHANGED** | They live in the meta location. |
| `worktree-changes.ts`, `worktree-removal.ts` | work-repo worktrees | **UNCHANGED** | dricket never touches work repos. |

### 2.2 `services/`

| Module | Verdict | Change |
|---|---|---|
| `board-service.ts` (4 009 lines — the writer) | **ADAPTED, the biggest cut** | Every `host.write`/`commit`/`renameInto` becomes a store call. Create (capture), refine, move, accept/send back, archive/unarchive, `setClaim`, header edits (`setPriority`, `setBlockedBy`, `setChain`, ...), `ticketSave`, parts edit/release, flow save all route through `TicketStore`. The `onVaultEvent` refresh round becomes "re-read changed ids" (§7). Archive and unarchive (`archiveCard`) reduce to a label + `move`. Normalization hook removed. Split the file by write family while doing it (it is the file most affected; a good moment, but do not make the split a precondition). |
| `chat-service.ts`, `chat-llm.ts`, `chat-model.ts` | **UNCHANGED** | Chat sessions are meta files. Chat *commands* (`setBlockedBy`, `setChain`, `promote`, ...) still execute through the board service. |
| `verify-service.ts`, `video-service.ts` | **ADAPTED (small)** | Verification section written through `put` while the verify step holds the claim; videos stay outside git, folder moves to the meta location (path constant only). |
| `persona-store.ts`, `persona-loader.ts`, `improvements-service.ts`, `repos-scan.ts`, `handover-config.ts`, `plan-shadow.ts` | **UNCHANGED** | Meta data. |
| `fleet-client.ts` (517), `host.ts` | **ADAPTED** | `EngineHost` loses the ticket-file methods (kept for meta files); gains nothing dricket-specific. |

### 2.3 `fleet/`

| Module | Today | Verdict | Change |
|---|---|---|---|
| `runner.ts` (638) | standalone loopback process, process table, idle shutdown | **UNCHANGED** | It does not own ticket writes; it calls the engine. Inferred: today the runner process reads the vault with `fs` (`event-writer.ts` header says so); those reads move behind the store or stay meta-only. |
| `runs.ts` (2 488) | run lifecycle: start, stamp `run:` map, steer, takeover tab, stop ladder, settle (tokens, cost, move) | **ADAPTED** | Start: `store.claim(id, owner=<persona>.<run-id>, size)` before the worker spawns; exit 11/12 = not started. Settle/move: `release(stage, message)`. Stale `run:` stamps disappear; "live run" is the claim plus the process table. Exit 13 on any write = stop the worker (fencing). Long waits for the owner: release to `needs-input`, re-claim on answer (new epoch). Inferred: the stamp-less-daemon retirement and `run:` validation code can be deleted. |
| `orchestrator.ts` (1 861) | the dispatcher/chain: selection, pools, personas, pause, budgets, breaker | **UNCHANGED** (selection) / **ADAPTED** (claim) | Selection stays Drey's (`dk next` is not used). `claimed-by` reads become `owner`; "a claimed ticket is not dispatched" now also respects a claim by *another machine*. Circuit-breaker park writes `stage: blocked` + comment instead of `parked-reason`/`parked-at`. |
| `event-writer.ts` | appends ledger and status log files, no commit per line | **ADAPTED** | Ledger: relocate (§6). Status log: `working:` stays in memory/SSE; keyed verbs become comments. This is where the "1 057 of 1 684 commits are bookkeeping" load disappears. |
| `worktrees.ts`, `worktree-clean.ts`, `worktree-home.ts`, `build-stamp.ts`, `procs.ts`, `capping.ts` | work-repo worktrees (`_worktrees/<id>/<repo>`, branch `t/<id>`) | **UNCHANGED** | Optionally add the four `Dricket-*` trailers to the runner's commits on `t/<id>` and run `dk validate --trailers` in the commit step as a gate (advisory without a host gate). Hook install and branch protection unchanged. `_worktrees/` moves with the ticket checkout location (path constant). |
| `providers.ts`, `assignment.ts`, `request.ts`, `handover.ts`, `context-pack.ts`, `protocol.ts`, `chain.ts`, `report.ts`, `telemetry.ts` | workers, ladder, briefs | **UNCHANGED** | The brief builder reads the ticket text from the store. |

### 2.4 `contracts/` and `server/`

| Module | Verdict | Change |
|---|---|---|
| `contracts/remote-protocol.ts` (`TicketsRemotePort`) | **UNCHANGED shape, narrower semantics** | `claim(cmd)` (modes `takeover` / `release`) -> "take over" = `force-release` (owner is admin) + `claim`; "release" = `force-release`/`release`. `ticketSave({id, text, baseRevision})`: `baseRevision` becomes the **`rev`** (integer as string) instead of a file hash; the `RefineReply`/conflict reply is unchanged (exit 12 -> "changed in the meantime"). `board()` payload unchanged; `phases` come from the stage config. |
| `contracts/tickets.ts` (677) | **ADAPTED** | `TicketMeta` gains `owner`, `epoch`, `rev`, `leaseUntil`; `claimedBy`/`claimedAt` derive from them; `run` is read from the runner's table, not the file. |
| `contracts/*` others (chat, flow, plan-approval, verify, changes, scout, device-list, replies, question-shape) | **UNCHANGED** | DTOs for Mission Control and Drey. |
| `server/router.ts`, `gateway.ts`, `auth.ts`, `qr.ts`, `needs.ts`, `settings.ts`, `engine.ts`, `engine-main.ts`, `service.ts` | **UNCHANGED** | Needs-you derives from status data (§5), not from file reads of `.status.log`: `needs.ts` is **ADAPTED (small)**. Settings gains `dk` path/version and `tickets.backend`. |
| `server/standalone-host.ts` (`FsEngineHost`) | **ADAPTED** | The single tickets vault becomes two roots: ticket checkout (managed by the store) and meta vault. |
| `server/drey-port.ts` | **UNCHANGED** | Adds the actor policy only; actor string becomes the `DK_OWNER` of the write (`owner@ipad`). |
| **SSE events** (`board`, `fleet`, `remote`, `chat`) | **UNCHANGED** | The *source* of `board` changes (§7). |

### 2.5 New modules

- `ports/ticket-store.ts`, `store/file-ticket-store.ts`,
  `store/dricket-ticket-store.ts` (spawns `dk`, JSON envelope decoding, exit
  code -> error kind table, version check against the bundled `dk`).
- `store/dk-process.ts`: serial queue per store for **writes** (dricket's
  local file lock already serialises; the queue avoids lock waits and bounds the
  number of `dk` processes), a small concurrency limit for reads, an
  `AbortSignal` per call (no wall-clock timeout on writes beyond dricket's own
  30 s budget; reads time out).
- `store/flat-frontmatter.ts`: parse/render of the flat format (shared with the
  phone client via the shim in `plugins/tickets/shared`).
- `store/ids.ts`: `T-0063` <-> `t-63`.
- `migrate/` (one-shot; see migration plan): reader of the legacy layout,
  writer through `dk` (needs [R-10]).
- A `dk` **contract test suite** that runs against a scratch store and snapshots
  the JSON of every command the store uses (this replaces my inability to
  capture real output in this analysis).

## 3. `plugins/tickets`

| Area | Verdict | Change |
|---|---|---|
| `main/engine-client.ts`, `engine-lifecycle.ts`, `engine-host.ts`, `mission-control.ts`, `mcp-tools.ts`, `chat-ipc.ts`, `dictation.ts`, `worker-models.ts`, `open-terminal.ts` | **UNCHANGED** | The plugin talks to the standalone engine over the same invoke/SSE channel. `engine-lifecycle` must pass the `dk` path and the two roots to the engine process. |
| `main/index.ts` (721), `path-announcer.ts` | **ADAPTED (small)** | Vault detection marker `tickets/_meta/pipeline.md` moves to the meta location; a tickets *workspace* is now (dricket store checkout + meta vault) — detect by `dricket.toml` on `main` plus the meta marker. `path-announcer` announces ticket paths after a `dk` write (paths are derivable from the id). |
| `renderer/` Work panel, ticket header, ticket document, review, ready, crew, workers, stuck, wait, chain alerts | **UNCHANGED** (DTO driven) | Strings that mention phases or folders ("move file", "Number folders") disappear with the settings below. |
| `renderer/settings-columns.ts` (567), `settings-model-picker`, `settings-page` | **ADAPTED** | Pipeline column editing writes the stage config; if dricket gets `[stages]` ([R-03]) that is a PR to protected `main`, **not** something `dk` does (`dricket.toml` is admin/PR only). The Settings column editor must either call a Drey-side helper that opens the PR/commit on `main` or become read-only plus "open `dricket.toml`". Open question Q-05. |
| `renderer/ticket-document/*`, `ticket-header.ts` | **ADAPTED** | The ticket is opened *as its file in the editor*. Saving must go to `ticketSave`/`dk` and must not leave a dirty file in the checkout (§5, R-02). |
| `shared/files-guard.ts`, `renderer/files-guard.ts` | **ADAPTED** | The guard that stops hand moves of ticket files in the Files panel now guards **any** write under the ticket checkout (the checkout is engine-managed; mark it as a plugin-managed repository, ADR-0082). |
| `remote/*` (the phone's legacy remote UI: `views.ts`, `kanban.ts`, `refine-view.ts`, ...) | **UNCHANGED**, to be retired | Already the fallback; it talks to the same gateway. |

## 4. How reading works with dricket

Three read paths exist; use them in this order.

1. **`dk ... --json`** is the contract. Today `ls --json` returns only
   `id, stage, owner, title, priority, kind, epoch, rev, labels` (comma
   string), and `show --json` returns `{id, content}` — the raw file, no parsed
   fields, no comments. That is enough for a first slice but not for a board
   with 100 s of tickets: `ls` spawns one `git show` per ticket (the
   implementation lists the tree, then reads each blob), and neither command
   carries `depends`, `parent`, `lease_until`, `size`, `created_*`, `branch`,
   `repos` or extension keys. Requirements [R-05], [R-06].
2. **Reading files from the ticket checkout** is physically fine (it is a
   normal working tree on the `tickets` branch; the protocol names it as the
   place people edit). It is **not** guaranteed fresh (a remote store needs
   `dk sync`; `dk show` reads the fetched head, not the working tree) and may
   be dirty. Rule for the engine: *read from the checkout only when it is
   clean and its `HEAD` equals the head the last `dk` call reported*; otherwise
   fall back to `dk show`. All **writes** go through `dk` — no `fs.writeFile`
   under the checkout, ever.
3. **`git` directly** for read-only history queries (`git log --follow
   -- <ticket path>`) is acceptable until `dk log` exists ([R-07]); it is the
   same `git` the engine already runs. Never for writes.

Who parses what: the engine parses the flat front matter and the body with its
existing pure parsers; Mission Control keeps parsing the ticket **text**
(`parseVerlaufEntries`, verification, plan parts in `libs/mission-ui`) because
`TicketDetail.text` stays the full markdown.

## 5. Contracts that change

| Contract | Change | Compatible with Mission Control? |
|---|---|---|
| Ticket id on the wire | unchanged display `T-0063`; store id `t-63` | yes |
| `TicketDetail.revision` | file hash -> `rev` integer string | yes (opaque to the client) |
| Remote `claim` route | meaning narrowed (see 2.4) | yes |
| SSE events | same four names; `board` payload may carry changed ids (nice-to-have) | yes |
| `## Verlauf` | **no change**: same section, same yaml lines (`dauer`, `ausgang` are file-format identifiers); written in the runner's claim | yes |
| `## Log` | Drey stops appending its own lines; dricket's lines `- <ts> <actor> <event>` appear. The story builder ("How it got here") reads both shapes. | yes after a reader change |
| Phase on the wire | `phase` ids come from the stage config (Q-05/C1) | yes if the ids are the same strings |
| Ledger | file moves to the meta location; line format unchanged; `phase` events removed | internal |
| Status log | files replaced by keyed comments (verbs unchanged); `working:` not persisted | internal; `needs.ts` and the Needs-you list change source |
| `run:` map | disappears from the ticket; run info comes from the runner's table and the claim | `TicketMeta.run` stays, filled from the runner |
| Own-write ledger / vault watcher | see 8 | internal |
| Commit messages `tickets: <id> <from> -> <to>` | become `dricket: <verb> <id>` | internal; anything that greps them (estimate history) moves to `dk log` |
| `specs/ticket-schema.md` | superseded section by section (see ADR-0090); the body-section and `_meta` parts stay | n/a |

### Editor saves and the dirty checkout (important)

In Drey the ticket **is** its Markdown file in the editor (E13-6). With
dricket, a file saved straight into the checkout is a dirty file; `dk sync`
refuses a dirty checkout and `dk commit` requires the caller to own the claim.
Resolution (in order of preference):

1. The tickets plugin registers a **save hook** for files under the ticket
   checkout and sends the text to `ticketSave` -> `store.put(id, text, ifRev)`
   (requires [R-02]); the editor's write never reaches disk by the normal
   path; the engine's `dk` write updates the checkout.
2. Interim without [R-02]: `put` = take a short human claim (kind `human`,
   size `S`), `sync`, write the file, `dk commit`, `release` to the same
   stage. Four commits per save is unacceptable beyond the first slice, so this
   is a stopgap for E14-4 only, behind a flag.

## 6. What lives where after the cut

| Data | Old home | New home |
|---|---|---|
| tickets, comments | `tickets/<phase>/` | dricket store, branch `tickets` |
| dricket config (`dricket.toml`, `prefixes.toml`) | n/a | store, branch `main` |
| `pipeline.md` (phases, handovers, pools, persona per column, `priorities`) | `tickets/_meta/` | meta location; stage list also in `dricket.toml` if [R-03] |
| personas, prompts, `repos.md`, chat sessions, ledger | `tickets/_meta/` | meta location |
| attachments (`img-*`, `verify-*`), videos | `tickets/attachments`, `tickets/videos` | meta location |
| `_worktrees/` | repo root `_worktrees/` | beside the ticket checkout (gitignored) |

The **meta location** is a second repository (recommended: the existing
`drey-tickets` repo, renamed in role only, with `tickets/<phase>/` removed
after the cut-over and a tag `pre-dricket` on the last legacy commit). The
alternatives (a third branch of the dricket repo, or a directory outside
`tickets/` on the `tickets` branch) fail respectively on "one working tree
cannot check out two branches at once" and on dricket's `unexpected-path`
rule.

## 7. Change detection and the own-write ledger

- **Detection of changes made by other writers** (another machine, a person at
  a terminal): the engine polls, not the vault watcher. Target: a cheap
  `dk changes --since <cursor>` ([R-09]); until then `git ls-remote`/`rev-parse`
  on the ticket ref, then `git diff --name-only old..new` restricted to
  `tickets/` — the exact recipe in dricket's CONCEPT ("Cheap check first").
  Interval 30–60 s plus an immediate refresh after each own write.
- **Own writes**: the engine already announces its writes to Drey
  (E2b-4, milestone 140): call `announceChanges` with the paths of the ticket
  files a `dk` call touched (derivable from the id) and emit `board`.
- **Drey's own-write ledger (`electron/own-write-ledger.ts`) and vault watcher
  (`vault-watcher.ts`)** are about writes made by Drey's `VaultManager`. `dk`
  runs in a subprocess, so its writes are *not* in the ledger. Consequences:
  with the opt-in watcher on, a `dk` write looks like an external change
  (clean tabs auto-reload — correct; a dirty ticket tab is marked "Changed on
  disk" — correct); the announce plus the watcher fire twice, which is
  idempotent. Recommended: register the ticket checkout as plugin-managed
  (ADR-0082) and exclude it from the watcher; rely on announce + poll. No code
  change in `electron/` is needed beyond that registration. The ledger itself
  stays for notes.
- **Git plugin / Source control panel** must not offer commit/push on the
  ticket checkout (a non-`dk` commit on `tickets` breaks the linear-history
  and one-ticket-per-commit invariants that `dk validate` replays).

## 8. `libs/mission-ui` and `apps/mission-control`

| Area | Verdict | Change |
|---|---|---|
| `libs/mission-ui/src/api/dto.ts` (1 923) | **UNCHANGED** | Includes `parseVerlaufEntries`, tolerant section parsers over the ticket text. `McTicketUsage`, estimate, plan DTOs unchanged. |
| `ticket/ticket.model.ts`, `view.ts`, `edit.ts` | **ADAPTED (small)** | `edit.ts`'s save sends `baseRevision`; semantic is now `rev` (opaque). Any place that shows "Log" lines must tolerate dricket's line shape. |
| `work/*`, `team/*`, `chat/*`, `flow/*`, `plan/*`, `settings/*`, `markdown/*`, `pairing/*` | **UNCHANGED** | |
| `apps/mission-control/src/app/api/state.ts` (1 899), `client.ts`, `sse.ts`, `fakes.ts` | **UNCHANGED** | Fakes can add a dricket-shaped fixture later; not needed. |
| Phase vocabulary in the UI | **UNCHANGED if C1 is solved by `[stages]`** | otherwise a mapping layer is needed. |

## 9. Deleted code summary (after cut-over, E14-7)

`core/normalize.ts`, `core/phase-dirs.ts`, the Log-line writer in
`ticket-files.ts`, `core/tickets-git.ts` for the ticket path,
`TransitionIo.renameInto/commit/push`, archive folder logic, `entered-*`
stamping (kept only as a read fallback for the migrated snapshot), `run:` map
stamping/validation, `.status.log` file IO and the ledger-in-ticket-repo
sweep, `order.md` leftovers, `settings-columns.ts` folder renaming ("Number
folders", reorder commit), the T-0041 numbered-folder tolerance, pipeline
`push:` after each transition (dricket publishes on every write), and the
fleet bookkeeping commits.
