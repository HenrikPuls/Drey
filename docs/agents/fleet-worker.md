# Fleet worker orientation

You run unattended on one ticket of the owner's board, in a worktree of
this repo on the ticket's branch `t/<id>`. Your brief names the ticket
file, quotes its description and plan, and carries the phase prompt —
that is your task. This page opens your brief in place of `CLAUDE.md`
(`instructions:` in the board's `repos.md`): it tells you where things
are and which of the repo's rules apply to you. Never read `CLAUDE.md`
or `AGENTS.md` whole; open `CLAUDE.md` only at the section a step needs
(search its headings).

## How to behave

- You can ask the owner, but only what blocks the step: end your turn
  with a message that starts with `QUESTION:` and follows this shape,
  one item per line: the question; "Ticket:" what the ticket is about
  in one line; "Where:" where you stand; "Why:" why you ask; "Options:"
  two to four numbered options, each
  "<n>. <option> — <its consequence>"; "Recommendation: <n> — <why>".
  The run waits, the owner is notified, and the answer comes back in
  this session (a picked option arrives as "<n>. <option>") — then go
  on. For example:

  ```
  QUESTION: Should dragging a heading also move the text below it?
  Ticket: Outline — drag headings to reorder the note.
  Where: step 2 of 4, the drop handler; step 1 is green.
  Why: the plan says "reorder headings" but not whether the section body moves.
  Options:
  1. Move the whole section — one undo step, what other editors do
  2. Only the heading line — the text stays, structure usually breaks
  Recommendation: 1 — it keeps the note's structure intact.
  ```

  Where `CLAUDE.md` says to ask, pause or wait for confirmation on
  something that does *not* block you (a choice the plan or the repo
  settles, a point for the review), decide within the plan and write it
  into the ticket's Log instead.
- Stay inside the plan's scope. No worktree of your own; no merge into
  `main` and no push unless your phase prompt asks for it (the commit
  step does) — otherwise the runner and the owner handle that.
- Do not start the app (`npm run dev`, `.\dev.ps1`, `npm run app`): there
  is no one to look at it. Unit tests, typecheck and lint are your proof.
- Everything code-side is English (identifiers, comments, commit
  messages, every string the UI shows). Notes a user writes stay as
  they are.

## Toolchain (no global Node)

- `.tools/` (portable Node) and `node_modules/` are linked into your
  worktree from the owner's checkout when the board's `repos.md` says so —
  the brief's "Toolchain" line tells you. Never run an install (`npm ci`,
  `npm install`) and never create or replace those links.
- PowerShell: `. .\env.ps1` once, then `npm run …`. Bash:
  `export PATH="$PWD/.tools/node:$PATH"`.
- One plugin's specs: `npm run test:plugin -- <id>` (a path fragment
  scopes outside `plugins/`: `shared`, `electron/ipc`).
- Renderer specs: `npm run test:app -- --include "src/app/…/x.spec.ts"`.
- Typecheck, all six configs (the plugins' build configs included): `npm run typecheck`. Import cycles:
  `node scripts/check-cycles.mjs`.
- Lint the files you touched:
  `node node_modules/eslint/bin/eslint.js <files>`.
- The full gate is `npm run test:all` (several minutes) — run it once at
  the end of a build step, not after every edit.

## Where things live

| Path | What |
|---|---|
| `electron/` | main process: vault and note IO, LLM transport, MCP server, plugin host |
| `src/app/` | Angular renderer: editor (`editor/`), panes and docks, settings, plugin host |
| `shared/` | pure logic both sides use; `shared/plugin-api/` is the versioned plugin SDK, `shared/ipc/` the IPC contract |
| `plugins/<id>/` | runtime plugins: `main/` (Node), `renderer/` (plain DOM, bundled), `shared/` |
| `plugins/tickets/` | this board and the fleet runner (`main/fleet/`); guides `FLEET.md`, `BOARD.md` |
| `specs/` | binding specs: `roadmap.md`, `changelog.md`, `decisions.md`, `frontmatter-schema.md`, `ticket-schema.md`, `classifier-spec.md` |
| `docs/` | arc42 docs; `docs/05_building_block_view.md` § "Feature → files index" maps a feature to its files; ADRs in `docs/09_architecture_decisions/` |
| `docs/manual/manual.md` | the user manual shipped in the app |
| `e2e/` | Playwright tests (need a full build — leave them to the owner unless the plan names one) |

A spec sits beside the file it tests. The dependency rules between
`shared/`, `src/`, `electron/` and `plugins/` are enforced by lint
(`docs/05` § "The dependency rules").

## Finding things without reading everything

- Start from the plan's file list and line ranges. Otherwise search for
  the symbol or the UI string, then read the lines around the hits.
- Every model call of your run carries everything read so far, so a
  file read twice is paid twice on every later call. Never read these
  whole, only line ranges around search hits: `specs/changelog.md`
  (a new entry goes at the top: its first 40 lines show the format),
  `specs/roadmap.md`, `docs/manual/manual.md`, `docs/05_building_block_view.md`,
  `plugins/tickets/main/index.ts`, `plugins/tickets/renderer/index.ts`.
- "Which file owns X": `CLAUDE.md` § "Ownership Map", then `docs/05`
  § "Feature → files index".
- Why something is the way it is: the ADR the code comment or the
  ownership map names; ideas already rejected: `specs/decisions.md` (do
  not re-propose them).

## Specs and docs your change owes

When your change alters what a spec file describes, update it in the
same branch: the table under `CLAUDE.md` § "The spec files and who they
belong to" says which file covers what, and the manual covers what the
user sees. Name every spec or doc you changed — or deliberately left —
in your Log line.
