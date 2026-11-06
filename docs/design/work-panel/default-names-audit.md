# Default names audit (E12-9)

Owner report 2026-11-05: the names in the default configuration do not match the
canvas "Drey Tickets — Workflow redesign". This audit lists every **default name the
app ships** (a name a fresh install, a freshly initialized board or an empty setting
shows without the owner having typed it) against the design.

**Sources and their limits.** The repo copies of the boards (`*.dc.html`) are stale
(see [README.md](README.md)); boards 7a–7j (`DeskWork` … `DeskReady`) are not in the
repo at all. So the reference here is the repo boards where they are still valid
(`Main`, `Home`, `Ready`, `Phone*`), the concept
([architecture-concept-v2.md](architecture-concept-v2.md): §5.1 pipeline, §5.7 flow,
§5.8 Shape, §4.2 personas, decision D7), [convergence-gaps.md](convergence-gaps.md)
and ADR-0087/0088/0089/0090. Where only a canvas board could settle a name, the row
says so and the item is a **question** — nothing was guessed.

Verdicts: **match** · **deviates** (fixed in this item) · **owned** (deviates, already
a roadmap item) · **question** (owner decides; not changed).

> **E12-9c (2026-11-05, milestone 166) supersedes rows 1, 17, 18, 19, 24 and 26 and answers Q1:** the owner decided the default pipeline `Inbox · Plan · Build · Review · Sign Off · Done`, the first column is titled **Inbox** again, and the shipped samples/manual/scratch pipeline follow. See [default-pipeline.md](default-pipeline.md).

## Table

| # | Default as shipped (file:line) | Name in the design (file / section) | Verdict | Action |
|---|---|---|---|---|
| 1 | Pipeline column `inbox`, title **Inbox** — `packages/tickets-engine/src/services/board-service.ts:82` (`DEFAULT_PIPELINE`, seeded by "Initialize board") | **Ideas** — `Main.dc.html` ("Ideas · The backlog"), `Home.dc.html` group, `PhoneCapture.dc.html` ("Saved to Ideas"), `PhoneInbox.dc.html` ("Ideas · drey"), `Shaping.dc.html` ("lands in Ideas"); no board says "Inbox" | **deviates** | Title → **Ideas** for a new board. The **id and folder stay `inbox`** (dricket stage, `10-inbox`, `entered-inbox`). Existing boards keep their title (test). |
| 2 | Pipeline column `prioritized`, **Prioritized** — `board-service.ts:83` | Group "Prioritized" — concept §6 line "groups instead of columns (Needs you, Running, Shaping, Prioritized, Ideas)" | match | none |
| 3 | Pipeline column `build`, **Build** — `board-service.ts:84` | "Build" gate — concept §5.1 | match | none |
| 4 | Pipeline column `commit`, **Commit** — `board-service.ts:85` | "commit" — concept §5.1; README "Move to Commit" | match | none |
| 5 | Pipeline column `done`, **Done** — `board-service.ts:86` | "Done · Merged, pushed, documented" — `Main.dc.html` | match | none |
| 6 | The shipped pipeline has **five** columns: no `review`, `verify`, `approve` — `board-service.ts:80-87` | Standard flow `build → review → verify → approve → commit → done`, "built (E4)" — concept §5.1, §5.7 (1) | **question** | Q1 |
| 7 | Work panel groups Needs you · Shaping · Running · Prioritized · Ideas · Done this week — `plugins/tickets/renderer/work-panel.ts:36-54` | Same names, same order — `Home.dc.html`, concept §6 | match | none |
| 8 | Track chips **Auto** / **Shape** / **Triage** — `work-panel.ts:615`; **Auto track** / **Shape track** on the Ready card — `ready-view.ts:75`; menu rows "Auto — runs on its own", "Shape — a plan-mode dialog with you" — `index.ts:3055-3056` | "Triage", "Auto track", "Shape track" — `Main.dc.html` | match (the short chip form is a size deviation, not a naming one) | none |
| 9 | Ready-to-try buttons **Move to <next column>**, **Archive** — `ready-view.ts` | "Accept and merge" in `Ready.dc.html` | match (README records req-86 as a deliberate deviation) | none |
| 10 | Default personas: **none are shipped** — "Initialize board" writes `pipeline.md`, `repos.md` and the prompts only (`board-service.ts:4540-4553`); the Team view starts with only the human persona **You** (`personas.humanName`, `board-service.ts:3893`) | Default team **Paul, Ben, Ralf, Tessa**, roles planner / builder / reviewer / tester; **Pia is Mission Control itself**; no design persona — concept D7, §4.2 | **question** | Q2 |
| 11 | Human persona title **You** — `board-service.ts:3893`, `flow-model.ts:56` | "you" / "You" — concept §5.7, `Orchestrator.dc.html` ("ask me") | match | none |
| 12 | Persona role enum `planner · builder · reviewer · tester · custom` — `core/persona.ts:36` | same — concept §4.2 | match | none |
| 13 | Persona and fleet default worker **opencode** (`contracts/fleet-defaults.ts:8`, `core/persona.ts:105` parse default) | `claude-code` in the concept's example persona (§4.2, "Paul") — an example, not a stated default | **question** | Q3 |
| 14 | Persona default model **opus** — `core/persona.ts` parse default | `opus` — concept §4.2 example | match | none |
| 15 | Mission Control chat voice labels "Paul, via Mission Control", "Paul suggests" — `libs/mission-ui/src/chat/chat.html:56,68,94,108`; the Assistant's Mission Control target is named after Mission Control — `plugins/tickets/renderer/conversation/targets.ts` | D7: Pia = Mission Control, Paul plans | match | none |
| 16 | Prompt templates `build-default`, `commit-default`, `plan-default`, `plan-interactive-default`, `qa-default`, `review-default`, `scout-default` — `packages/tickets-engine/prompts/` | `qa-default` (verify), `scout`, plan prompts — concept §5.2, §5.6; `refine-interactive-default` is gone (concept §5.8 update) | match | none |
| 17 | Phone capture button **Create in Inbox** — `plugins/tickets/remote/views.ts:602` | "Saved to Ideas" — `PhoneCapture.dc.html:25` | **deviates** | Label follows the first column's title (`Create in Ideas` on a new board, `Create in Inbox` on a board that still calls it Inbox). |
| 18 | Settings → Tickets → Pipeline hint "Inbox and Done stay first and last" — `plugins/tickets/renderer/settings-columns.ts:63` | first column is Ideas by default | **deviates** | "The first and the last column stay in place." (true for any title) |
| 19 | Manual wording "Inbox (where new tickets land)", "parks in Inbox", "back to Inbox", "Capture — a new ticket into the Inbox" — `docs/manual/manual.md` | Ideas | **deviates** | Reworded to Ideas; folder ids (`10-inbox`) stay and are said to. |
| 20 | Dock panel title **Work** — `plugins/tickets/renderer/index.ts:688,3222` | **Tickets** — boards, ADR, desktop-integration (G-10) | owned | E13-14 |
| 21 | Panel footer **Workers** link, no "Team · Ben, Tessa busy" — `index.ts:1264-1269` (G-11) | Team footer — boards 7a–7c | owned | E13-14 |
| 22 | Status-bar item "2 running · 3 need you" as one item (G-12) | split cost / need-you items — boards 7a, 7h, 7i | owned | E13-15 |
| 23 | Title-bar capture label / chord (G-13) | Ctrl+Alt+T | owned | E12-7 |
| 24 | Scratch dricket store `[stages] values = ["inbox","prioritized","build","commit","done"]` — `scripts/verify-dricket.ps1:254`, `migrate/convert.ts:31` (`DEFAULT_MIGRATION_CONFIG`) | stage **ids** are storage, not display; titles live in `pipeline.md` | match (ids) | none in Drey; see "dricket side" below. The scratch `pipeline.md` of `verify-dricket.ps1` now titles the first column Ideas to match a new board. |
| 25 | E2E and spec fixtures that spell their own pipeline with `title: Inbox` (`e2e/*.spec.ts`, `migrate/fixtures/legacy-vault`) | — | match (these play an existing user's board) | none: they are the "existing config keeps its name" cases |
| 26 | Shipped sample in `specs/ticket-schema.md` (`pipeline.md` example) | Ideas | **deviates** | Example title updated. |

Counts: **26 rows, covering about 55 individual names** (5 column titles, 6 group
titles, 3 track names plus their long forms, 3 flow roles, 7 prompt names, 5 roles, the
persona defaults, 4 panel/status labels, the capture/hint/manual strings). Deviations:
**5** fixed (1, 17, 18, 19, 26), **4** owned by an existing roadmap item (20–23),
**3** questions (6, 10, 13).

## Questions for the owner

**Q1 — Does the default pipeline gain `review`, `verify`, `approve`?** The concept
(§5.1, §5.7) calls `build → review → verify → approve → commit → done` the standard flow
and marks it built (E4), with prompts `review-default` and `qa-default` shipped. A new
board still gets `inbox · prioritized · build · commit · done`: Build flows into Commit
with no review, no verify run and no manual approval. Adding three columns is not a
rename. It changes what a new board *does* (fleet pools, a manual checkpoint, the
dricket `[stages]` vocabulary and the migration's `DEFAULT_MIGRATION_CONFIG`). The
canvas boards 7e (DeskBoard) and 7g (DeskSettings), which would show the default
columns and "Default flow", are not in the repo. Which columns does the default show,
and in which order?

**Q2 — Should "Initialize board" seed the default team Paul, Ben, Ralf, Tessa?**
Decision D7 fixes the names and roles (planner, builder, reviewer, tester), but no code
creates them: a new board has only the human persona *You*, so the Team view, "Plan
Paul, Build Ben …" in the manual and the flow editor's persona pins show nothing until
the owner adds personas by hand. Seeding needs, per persona, a `persona.md`, a
`prompt.md`, a worker, a model and a colour; a seeded persona also takes part in the
resolution ladder. Seed them (with which worker and model), or keep the team empty
until the owner builds it?

**Q3 — Default worker `opencode` or `claude-code`?** The fleet and the persona parser
default to `opencode`; the concept's example persona uses `claude-code`. Nothing in the
design names a default worker, so this is a product decision, not a naming one.

## dricket side (not touched)

The stage vocabulary is dricket-side configuration, `[stages]` in `dricket.toml`
(`dk init` writes none; the migration and `scripts/verify-dricket.ps1` append
`values = ["inbox","prioritized","build","commit","done"]`). Drey uses the stage id as
the phase id and shows the title from `pipeline.md`, so **E12-9 needs no dricket
change**. A dricket change would be needed only if the owner wants the *id* `ideas`
instead of `inbox`, or Q1 adds `review`, `verify`, `approve`: then `[stages] values`
gains those ids (and `claim` the agent stages), `initial` stays the first one, and the
migration config `DEFAULT_MIGRATION_CONFIG.stages` and the reverse converter follow.
`dricket.toml` of the owner's real store is not edited by any of this.
