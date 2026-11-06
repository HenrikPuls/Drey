# Flaky tests — causes, fixes, how to check (D-8)

The release gate (`npm run test:all`) failed intermittently, worse when several
gate runs overlapped on the machine. This page records what was measured and
what the causes were, so the next flake is looked for in the same places.

## Method

Reproduce first: loop the suite (or the suspect specs) and run copies side by
side, with CPU burners on top (`node -e "while(true){}"`, 6-12 of them). Per
flake: find the work that outlives the test, fix the owner of that work, then
repeat the loop under the same load.

```bash
node node_modules/vitest/vitest.mjs run --config vitest.plugins.config.mts <specs>
```

## Failure rates

Before = state of `desktop-integration` (c6cf26a1); after = this change. A run
is one invocation, failed when at least one test failed.

| Scenario | Before | After |
|---|---|---|
| runs / engine / store-git-probe specs, 3 copies side by side | 3 of 24 runs | see the last row |
| engine.spec alone, 4 copies side by side (videos.limitMb, ENOTEMPTY seen in the owner's runs) | 1 of 60 runs | see the last row |
| runs.spec + store-git-probe, 5 copies side by side (probe: 5 s timeout) | 1 of 60 runs | see the last row |
| whole plugin suite, 2 copies side by side | 2 of 2 runs (12-13 failed tests each) | 10 of 10 green (also 6 CPU burners) |
| whole plugin suite, 4 copies side by side | 4 of 4 (42-47 failed tests) | not repeated |
| runs / runs-dk / engine / probe / dk-put specs, 3 copies + 12 burners | 9 of 18 (24 burners: 18 of 18) | 21 of 21 green |

## Causes and fixes

1. **Oversubscription (the dominant one).** vitest started one worker per
   core (32 here); many specs spawn real `git` / `dk` processes, and on Windows
   process creation is the scarce resource. A 1-5 s real-git spec crossed the 5 s
   default, hooks timed out, and children were still alive when `afterEach`
   removed their directory (`EBUSY`, `EPERM`, `ENOTEMPTY`). Fix:
   `vitest.plugins.config.mts` caps the workers (a quarter of the cores, 2-8);
   the suite got faster (97 s instead of 175 s with two copies) and green. The
   process-spawning specs (`packages/**`, `plugins/git/**`) are their own vitest
   project with a 60 s budget — their 5 s default measured machine load, not
   correctness; a hung test still fails.
2. **`createEngine` started work it never awaited** (`void videos.prepare()`:
   creates `tickets/videos`, writes `.gitignore`, drops the retired
   `videos.limitMb` key). It raced `afterEach`'s `rm` of the vault
   (`ENOTEMPTY … tickets`) and the `videos.limitMb` spec polled for it for at
   most one second. Fix: the promise is kept; `Engine.ready` exposes it, `close()`
   awaits it, then `board.idle()` and `git.idle()`. The spec awaits `engine.ready`.
3. **Background git children outlive `stop()`/`dispose()`.** `TicketsGit` had
   no way to wait for its queued commands (`idle()` now), `StoreChangeFeed`
   started HEAD reads, ref checks and sync rounds with `void` (all tracked now,
   `idle()`), `StoreBoardSource` also owns the shadow comparison
   (`idle()` waits for it). `dispose()` stays synchronous; the shutting-down
   owner awaits `idle()` before it lets go of the folder
   (`DricketFileStore` specs `EPERM`, engine `EBUSY`).
4. **`RunSupervisor` fire-and-forget work** (`void this.persist/onWorkerExit/…`,
   the per-run event queue, the interrupt of a soft pause) wrote ticket and run
   files after the spec had passed its last assertion (`ENOTEMPTY …\tickets\plan`
   in "a soft pause waits…"). Fix: the supervisor tracks that work and offers
   `idle()`; the specs drain every supervisor they built before removing the
   temp dirs (`fleet/run-spec-support.ts`, shared by `runs.spec` and
   `runs-dk.spec`).
5. **`settled()` polled a clock.** It waited for the `onRunSettled` event by
   polling with `vi.waitFor`'s 1 s default (`expected 'not settled yet'`). Now it
   awaits the event itself; the other `waitFor` polls use the test's own 5 s as
   their ceiling.
6. **A test-side lost wake-up** in "defers while a run is in its machine gate":
   the gate's release function was assigned inside `execShell`, but the blocker
   turns true when the run *enters* the gate state, possibly before `execShell`
   is called — `releaseGate()` then fired into the void and the gate never
   opened (a real hang, only visible on a slow machine). The gate promise now
   exists before the run does.

## Rules for new tests

- A component that starts background work exposes how to wait for it
  (`idle()` / `ready` / the returned promise), and `stop()`/`dispose()`/`close()`
  is not "done" before that work ended. Never `void` something a test's temp dir
  depends on without tracking it.
- Await the shutdown before removing a temp dir. No retry loop around `rm`.
- Wait for an event or a promise, not a clock; when a poll is unavoidable, its
  ceiling is the test's own timeout.
- Specs that spawn real processes live under `packages/` or `plugins/git/`
  (the `processes` project) or are added to `PROCESS_SPECS` in
  `vitest.plugins.config.mts`.
