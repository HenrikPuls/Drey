# Owner guide — verification round and cut-over to dricket

Status 2026-11-05. For the owner: what to check in the running app (milestones
154–161 are all "Not yet manually verified"), and how the cut-over (E14-7) goes.
Nothing here touches the real `drey-tickets` repository until step C.

Requirements: `dk` v0.6.2 or newer on PATH (or `tickets.dk.path`), the build of
`desktop-integration` (`.\dev.ps1 -Built` — always a fresh production build, no
DevTools), git. Keep every store and data folder on a **short path** (about
190 characters at most) and **outside OneDrive**.

## A. Verification round on a scratch store (no risk)

1. Make a scratch store: `dk init E:\dkv` (a local store; or a bare repo plus a
   separate clone for the remote case). Create a few tickets with `dk add -m "..."`.
2. Point a **second Drey instance** at it without touching your real settings:
   `.\dev.ps1 -Built -Multi` shares one userData with the first instance, so close
   your normal Drey first, or start with a temporary profile
   (`$env:USERPROFILE` to a temp folder; the live engine home is `~/.drey-engine`).
3. Plugin config of the tickets plugin is `<userData>/plugins/tickets/config.json`
   (flat JSON; no UI yet for the first two keys):
   `"backend": "dricket"`, `"dk.store": "E:\\dkv"`. Optional: `"dk.checkout"`
   (empty = the store folder itself), `"dk.syncSeconds"` (remote stores only,
   default 30), `"dk.path"` (a `dk` outside PATH), `"dk.dataDir"`.
   Settings → Tickets shows checkout and sync seconds.
4. Check, in this order:
   - the board shows the scratch tickets; a `dk add` / `dk put` from a terminal
     appears within about 1–2 s (watcher) without refresh;
   - the board's own moves: capture, priority, stage move, accept / send back — each
     is one `dricket: put …` commit (`git -C E:\dkv log --oneline`);
   - open a ticket document in the editor, edit, Ctrl+S — a `put` commit; edit the
     same ticket from a terminal in between: the save conflict merge view opens;
   - a ticket's comments (`dk comment t-1 -m "x"`) show in the thread; a Needs-you
     decision resolves via a comment (there is **no answer button yet**);
   - one fleet run on a throw-away ticket: claim, extend, release visible in
     `dk show`; kill the runner (Task Manager) and start Drey again — the leftover
     claim is released at start; a *foreign* dead claim is taken over only after
     lease end **plus dk's fixed 20-minute grace**;
   - Source control marks the checkout "Managed by Tickets".
5. Anything wrong: note it as a requirement (ids in `specs/roadmap.md`), do not
   fix by hand-editing the store.

## B. Shadow comparison on a copy of the real vault (no risk to the real one)

1. Copy your real `drey-tickets` folder (the legacy vault) to a scratch place.
2. Migrate the copy: `npm run build:plugins`, then
   `node scripts/migrate-tickets.mjs --legacy <copy> --allow <ids.txt>` (dry run,
   read the report), then add `--apply --store E:\dkm --dk <dk> --report <file>`.
   The allow list is the ticket ids that are migrated (the non-done ones). A ticket
   with a run stamp needs `--allow-live-runs` — make sure no run is really live.
   The apply writes real numbers and creation data, no placeholders, and runs
   `dk validate` itself (non-zero exit if it fails).
3. Set `"backend": "shadow"` with `"dk.store": "E:\\dkm"`: the UI keeps showing the
   files board; read `~/.drey-engine/shadow/board-diff.md` until it is identical
   (known, declared difference: a `blocked-by` pointing at a done ticket outside
   the allow list is dropped by the migration and kept in `x-legacy-blocked-by`).

## C. The cut-over (E14-7) — your decision, the one step that touches the real data

Only after A and B are clean.

1. **Freeze:** stop the fleet/chain, no running agents, close other instances; note
   the commit/state of `drey-tickets` (it is also your backup — never delete it).
2. **Final import:** re-run the migration (step B.2) against the real, frozen
   vault with a **fresh allow list**, into a **fresh** store folder (the apply
   refuses a store that already has tickets). `dk validate` must be clean.
3. Set `"backend": "shadow"` once more and read `board-diff.md` — identical.
4. **Flip:** `"backend": "dricket"`, `"dk.store"` = the new store. Smoke: the
   board, one move, one editor save, one comment, one short fleet run.
5. **Rollback** stays possible until E14-9b: set `"backend": "files"` again for the
   old vault, or run the reverse converter (`--reverse --store <store> --out <new dir>
   --dk <dk>`) to write a legacy vault from the new store. Work done on dricket
   since the flip exists only in the store until you reverse it.
6. After your round is satisfied, E14-9b (decommission, scope in
   `docs/design/dricket/decommission.md`) deletes the legacy code.

## Known gaps (not blockers for A–C)

No answer button for Needs-you in the UI (route and engine method exist); a worker
cannot edit its own ticket chapters on a store (`## Handover`); no "release leftover
claims" button (runs automatically at start); chain on a remote store does not
`dk sync` by itself (the engine's feed does); no real run with a real worker was
made on a second instance. Full list: `specs/roadmap.md`, E14-5c and E14-6
follow-ups.
