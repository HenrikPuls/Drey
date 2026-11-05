# Read and write cost on dricket — measurements and verdict

Measured 2026-11-05 on the owner's Windows 11 machine with `dk` v0.6.0 against
scratch stores (never `drey-tickets`): `E:\dkb\s` for single calls and
`E:\dkb\mig`, the migrated store (91 tickets: 22 real, 69 placeholders), for
the board. Few repetitions each; these are orders of magnitude, not a
benchmark suite. No remote was involved, the stores are local.

## Read path: `dk` vs files

The board needs every ticket with its full text. Two ways to get it, same
data (id, stage, rev and title of all 91 tickets match):

| Read path | Time |
|---|---|
| files: walk `tickets/**/ticket.md`, parse with `detailFromContent`, first run | 28 ms |
| files, median of 20 | 18 ms |
| files, 500 tickets (copies of the 91, no comments), first / median of 10 | 552 ms / 133 ms |
| `dk` cold: `ls` + one `show` per ticket (E14-2's `StoreReader`), 3 runs | 29.9 / 29.3 / 29.2 s |
| `dk` warm: `ls` only, no row changed | 2.0 s |

`dk` reads had to run serially: with the default four parallel reads dk
fails with `reset to local head: exit status 128` (requirement R-26). The
500-ticket `dk` figure (about 160 s) is an extrapolation, not a measurement.

**Verdict:** reads leave `dk` (E14-4, owner decision 2026-11-05). The
checkout of the `tickets` branch is current after every `dk` write.

## Write path and single handgrips

| Handgrip | Time |
|---|---|
| `dk put <id> -F f --claim --if-version <rev>` (claim, write, release: one commit) | 0.62 - 0.69 s |
| `claim` + edit + `commit --release` | 1.5 - 2.3 s (claim 0.4 - 1.2 s, commit about 0.87 s) |
| `dk sync` (local) | 0.09 - 0.11 s |
| `dk add` | about 0.76 s |
| `dk validate`, near-empty store | 1.4 s |
| migration of 91 tickets into a fresh store | 143 s |

`put --claim` alone fails on a ticket the caller does not hold: it needs
`--if-version`.

## Where the time goes

`GIT_TRACE2_EVENT` on a local store:

| dk call | git processes started | sum of their run times (tracing on) |
|---|---|---|
| `dk show t-1` | 16 (7 `rev-parse`, 2 `show`, `reset`, `clean`, `checkout`, `worktree`, `remote`, `check-ref-format`, `status`) | 755 ms of 1004 ms wall |
| `dk ls --json` (91 tickets) | 107 | 4.9 s of 6.1 s wall |

A bare `git rev-parse HEAD`, `git status` or `git log -1` takes 47 - 50 ms
from this shell, the same as an empty `cmd /c exit 0` (47 ms): the cost of
one git call here is the **process start**, not git's work. Tracing itself
inflates the numbers (an untraced `show` is about 0.4 s); the shape holds:
nearly all of a `dk` call is spent starting git processes, and the number of
processes is `dk`'s choice (one `show` starts 16; `ls` starts about one per
ticket plus the fixed ones).

## What is git's, what is dk's

- **Git-bound, cannot be removed while dk uses the installed git:** the
  fixed cost of a git process start on Windows (about 20 - 45 ms each); the
  commit itself (write objects, move the ref, fast-forward the checkout);
  with a remote, fetch and push over the network. How a commit splits
  between these has not been measured.
- **dk-bound, can be reduced in dricket:** how many git processes a command
  starts. Every read also resets, cleans and checks out a private working
  copy; that housekeeping is also the cause of the parallel-read failure
  (R-26). A read through git plumbing (`ls-tree` plus `cat-file --batch`)
  would need a handful of processes for the whole store; skipping the reset
  when `HEAD` has not moved removes most of the rest. Embedding a git library
  would remove process starts altogether; whether that fits dricket's
  "uses the installed git" design is dricket's decision, not assumed here.
- **Moot for Drey:** the board no longer reads through `dk`, so the dk-bound
  read cost does not reach the user.

## Where speed matters

| Flow | Cost | Matters? | Lever | Verdict |
|---|---|---|---|---|
| Board build / refresh | 29 s -> 18 ms | yes, the one real bottleneck | file reader (E14-4) | solved |
| Change detection | no process start | no | watcher with debounce | solved |
| Interactive edit (persona, stage, header) | about 0.6 s | barely | show the change at once, confirm after `dk` returns | optional |
| Agent run start (claim) | 0.4 - 1.2 s | no (runs take minutes) | none | ignore |
| Lease extend (background) | about 0.5 s per call | no | do not set the interval short | ignore |
| Run end (commit, release, comment) | 2 - 4 s together | under 1 % of a run | `put` / `commit --release` as one commit | note for E14-5 |
| `dk validate` in the commit step | 1.4 s near-empty, large stores unmeasured | no, but grows with the store | at gate and cut-over only | check when built |
| Remote push per write | not measured | yes, if a remote is added | batch writes, sync periodically | measure then |
| Migration | 143 s | no, once | none | ignore |

Not measured: any remote, `validate` on a large store, the effect of a
virus-scanner exclusion or git settings (`core.fsmonitor`, `gc.auto=0`).
Nothing beyond the file reader is worth building for speed on current
evidence; correctness (`--if-version`, fencing) and robustness (watcher,
sync) matter more.

## Appendix: the git processes of one `dk show`

From `GIT_TRACE2_EVENT` (arguments shortened; the private working copy lives
under `%LOCALAPPDATA%\dricket\<store>-<profile>`):

| # | Command | Purpose (inferred from the arguments, not from dricket's code) | Needed for a read? |
|---|---|---|---|
| 1, 2, 6, 7, 9 | `rev-parse --is-inside-work-tree`, `--show-toplevel` (twice), `--is-bare-repository`, `--git-common-dir` | find and classify the repository | one call can answer all five |
| 3 | `show refs/heads/main:dricket.toml` | read the configuration | yes, once |
| 4 | `remote get-url origin` | local or remote store | yes, or merged with discovery |
| 5 | `check-ref-format --branch tickets` | validate the branch name | no: a string check in process |
| 8, 10, 12 | `rev-parse`, `worktree list`, `rev-parse` in the private copy | check the private working copy | writes only |
| 11 | `status --porcelain=v1 -z --untracked-files=all` | state of the user checkout | no |
| 13, 14, 15 | `reset --hard`, `checkout --detach`, `clean -fdq` | bring the private copy to the ref head | writes only |
| 16 | `show HEAD:tickets/<prefix>/<shard>/<id>/ticket.md` | the actual read | yes |

`dk ls --json` runs the same preparation and then `ls-tree` plus 91 single
`git show HEAD:<path>` calls: 107 processes in all. One batch read
(`git cat-file --batch`) would replace the 91. Requirements R-29 (trace) and
R-30 (fewer processes) in `dricket-requirements.md` carry this to dricket.
