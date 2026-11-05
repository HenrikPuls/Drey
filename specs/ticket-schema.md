# Ticket Schema — the tickets repository format

The complete, machine-facing specification of the tickets repository
(ADR-0076; the fleet that works it is ADR-0075). Written so that a
human, a Drey component, or an agent CLI can operate the format from
this file alone. Ticket files are **not** vault notes — only the YAML
conventions shared with [`frontmatter-schema.md`](frontmatter-schema.md)
apply (quoted dates, plain text).

Top-level rules, once, up front:

- **One file per ticket. The phase is the directory. The filename is
  the identity.** A ticket file moves between directories; its name
  never changes.
- **Phase directories are numbered** (T-0041): `NN-<id>` with `NN` the
  phase's 1-based pipeline position × 10 — `10-inbox`, `20-prioritized`,
  … `80-done`. The number lives ONLY in the directory name: `entered-*`
  keys and branch names keep the clean id.
- **Every phase transition is one git commit** (`git mv` semantics +
  the frontmatter stamp), message format
  `tickets: <id> <from> -> <to>` (ASCII arrow).
- **A file move between phase folders is a ticket move.** Moving a
  ticket file outside the board (Explorer, Files panel) has exactly the
  effect of a board transition: on the next board refresh, stateless
  normalization detects the ticket sitting in phase B with an
  inconsistent `entered-<B>` stamp and completes the treatment — stamp,
  Log line, one commit `tickets: <id> <from> -> <to>`,
  actor `owner@<host>`. Works after restarts (derived from the files,
  no extra state); lane rules are never enforced on human moves —
  logged, not blocked.
- **A refine from the remote is one commit** (req-66):
  `tickets: <id> refined`, with one Log line
  `- '<UTC>' owner@<device> — refined (<what changed>)` — the header
  keys (`title`, `priority`, `repo`) and section names (`description`,
  `plan`, `acceptance criteria`). It replaces a section's body up to the
  next heading of any level (so `## Plan` keeps its `### Acceptance
  criteria`), adds a missing section before `## Log` (Acceptance
  criteria at the end of Plan), and never touches the Log otherwise.
- **Machine writers write strictly** (the exact shapes below);
  **humans edit freely**; **readers normalize visibly** — anything a
  reader cannot parse unambiguously is reported as an issue on the
  board, never guessed. Tolerate noise, never ambiguity.
- All timestamps are **UTC, seconds precision, quoted**:
  `'2026-10-17T14:32:00Z'`.
- Line endings LF. Encoding UTF-8.

## Layout

```
<tickets repo root>/
  _worktrees/       # reserved (T-0044): the fleet's worktree home —
                    #   <ticket-id>/ per ticket, gitignored, invisible to
                    #   the vault's tree/index/watcher
  tickets/
    _meta/
      pipeline.md     # the phases + handover config (config, never data)
      order.md        # ignored since req-75 W1 (the former order pins), may be absent
      repos.md        # work-repo name -> clone URL/path mapping
      prompts/        # the handover prompts (`agent <prompt-ref>` names one file)
      personas/       # the agent personas (E3, the improvement loop E6):
                      #   <id>/persona.md + prompt.md + memory.md + friction.md +
                      #   improvements.md (+ avatar.png) — see Personas below
      chat/           # the Mission Control chat sessions (E5a): one file per
                      #   session — see _meta/chat/ below
      ledger.jsonl    # the fleet event ledger (E7) — see The fleet ledger
    10-inbox/
      T-0042.md       # one ticket per file, in its current phase's folder
    20-prioritized/
    30-build/
    40-commit/
    50-done/
    archive/          # reserved (T-0041): archived tickets, never a column
    attachments/      # reserved (req-66 R8): images a paired device
                      #   uploaded — binary only, never a column, never
                      #   a ticket
    videos/           # reserved (E11, ADR-0088 later change): the proof
                      #   walkthrough videos — binary only, never a
                      #   column, not in git by default (see Videos)
```

The phase folders are exactly the phases configured in `pipeline.md`
(the set above is the default, not fixed). `_meta`, `archive` and
`attachments` are reserved; nothing else lives beside the phase
folders. A vault whose root contains `tickets/_meta/pipeline.md` **is**
a tickets vault — that file's presence is the detection marker.

**Reserved `_`-prefixed folders at the repo root (T-0044, ADR-0080).**
`_`-prefixed names directly beside `tickets/` are machine state, never
ticket data: the board, the vault's markdown index and the file watcher
skip them entirely, and the repo's `.gitignore` covers them (ensured by
the boot sweep, one commit when appended). The fleet's worktrees live in
`_worktrees/<ticket-id>/` by default; a repo can override its base with
a `worktrees:` key in repos.md. The skip is root-depth only —
`tickets/_meta` stays indexed and watched.

### Numbered folders (T-0041)

`NN` is derived from the phase's position in pipeline.md (1-based × 10,
two digits). Readers strip a leading `\d+-` from the directory name and
match the rest against the pipeline ids; **an unprefixed directory
stays tolerated** (`tickets/inbox/…` reads exactly like
`tickets/10-inbox/…` — the migration of an existing repo is 8×
`git mv`, and ship order is free). Writers resolve their target
directory per move: the derived `NN-<id>` name when it exists, else any
existing directory whose stripped id matches, else the derived name
(created on first use). Inserting a column by hand takes a **gap
number** (`35-qa`) — no move ever renumbers existing directories, so
there is no rename cascade. Directory names are never written into
ticket files or branches.

**Renumbering is an explicit owner action** (req-50, Settings →
Tickets): reordering the columns there rewrites `pipeline.md` and
renames every phase folder whose number no longer matches its position,
in **one commit** (`tickets: reorder phases <ids…>`); "Number folders"
does the renaming alone (`tickets: number phase folders`) — the
migration of an unprefixed repo, or tidying gap numbers. Several
folders of one phase (an unprefixed `inbox` beside a machine-made
`10-inbox`) fold into the derived one; `_meta`, `archive` and folders
that name no phase are never touched. Both refuse while a ticket in a
renamed folder has a live `run:` (the runner holds its path), and
refuse before touching anything when two files of one name would land
in one folder.

### Archive (T-0041)

`tickets/archive/` is a reserved folder beside `_meta`: **not a board
column, invisible on the board, no counter display**. Archiving goes
through the Work row menu (two-step armed), the Accept of a finished
ticket (req-75 W1), or by moving the file into
`archive/` — both yield the Log line `archived` (a machine-shaped
`— archived` marker, NO `entered-archive` stamp; claim fields ride
along) and exactly one commit `tickets: <id> archived`. Reviving is a move back into a phase folder — normalization
treats it as `archive -> <phase>`. Body edits after archiving never
re-fire normalization. Final deletion is the owner's manual act inside
`archive/`.

### Attachments (req-66 R8)

`tickets/attachments/` is a reserved folder beside `_meta` and
`archive`: **binary image files only, never a column, never a ticket**
(the board lists markdown only, so no column ever appears). An image
pasted or picked on a paired device is saved here by the desk — the
type sniffed from the bytes (PNG, JPEG, GIF, WebP, ≤ 6 MB), never from
a client-sent name — as `img-<yyyyMMdd>-<HHmmss>-<4 hex>.<ext>`, in
exactly one commit `tickets: attachment <name>` (no Log line: the Log
lives in ticket files and an upload touches none — Capture uploads
before a ticket exists; the audit is the gateway's `remote <device>:
attachment` line and the commit). Notes and ticket files embed the
image with `![](../attachments/<name>)` — a phase folder moves on every
transition, so only this fixed folder keeps the links intact.

### Videos (E11, concept v2 §5.3)

`tickets/videos/` is the third reserved folder beside `_meta`,
`archive` and `attachments`: **binary video files only** — the proof
walkthrough of a ticket whose proof mode is `ui` (see
[Proof mode](#proof-mode-e11)). The board, the validator and the drift
pass treat it exactly like `attachments/`: skipped as ticket data,
never a column, never reported as a stray file.

- **Name:** `verify-<yyyyMMdd>-<HHmmss>-<ticket id>.<mp4|webm>`; the
  ticket's `## Verification` section references the video by name
  (a `### Video` chapter with `![](../videos/<name>)`), never by a path
  a phase move could break.
- **Not in git by default.** The engine maintains
  `tickets/videos/.gitignore` with exactly `*` and `!.gitignore`, so a
  video never enters a commit. Engine config key `videos.inGit`
  (default `false`) lifts that: the engine then removes the ignore
  rule. Turning it on is a confirmed act (Settings → Engine) carrying
  the warning "Videos are large binary files. Once committed they stay
  in the history even if you delete them later, and the repository
  grows with every one. Keep this off unless you have a plan for the
  size (for example Git LFS)." Existing videos are **not** committed
  retroactively unless the owner ticks "Include the n existing videos"
  in that dialog.
- **Size rule (owner decision, 2026-11-04).** One limit, per video:
  engine config key `videos.maxMb` (default `25`) caps a single
  recording. There is **no retention limit** — neither by age nor by the
  size of the folder — and nothing is deleted automatically; videos stay
  until the owner deletes them, bounded only by the disk. Supersedes the
  earlier `videos.limitMb` (total folder size, oldest `done` videos
  deleted first), which no longer exists: a stored `videos.limitMb` is
  ignored and removed from the config at startup (E11-1c, milestone 147).
  The settings accept a whole number of MB from 1 to 200.
  **A recording larger than the cap is not kept** (the verify step
  checks the file right after the harness stored it: exactly the cap is
  kept, one byte over is not; Playwright cannot trim, and nothing
  re-encodes): the file is deleted — the one deletion the engine ever
  does, of the recording it was about to reference — and the
  `### Video` chapter carries one line instead of the player,
  `Video not kept: <N> MB exceeds the <cap> MB limit.` (N rounded up
  to a tenth). Existing videos are never touched.
- **Served** by the engine's bearer-authenticated
  `GET /api/videos/<name>` with HTTP `Range` support (Safari needs it
  to stream), the name pinned like `/api/attachments/<name>` to
  `[A-Za-z0-9._-]+.(mp4|webm)` with no slashes.

### Id minting

`T-` + at least four digits, zero-padded to four (`T-0042`, `T-1327`,
`T-10000`). The next free id is **max of all existing ids across every
phase folder + 1** (never reuse a gap — a deleted ticket's id stays
burned; git history is the record). If two sides minted the same id
independently, the merge conflict is resolved by the **later** side:
re-mint the next free id and rename file, `branch:` field and the work
branch together in one commit.

### The branch rule

The work branch of a ticket is deterministic: `t/<id>` (`t/T-0042`).
The `branch:` frontmatter field is cross-validated against the rule —
**the rule wins**, a mismatch is an issue badge, not an error. Machine
writers always write the rule's value.

## Ticket file

```markdown
---
id: T-0042
title: 'Fix the palette race in CI'
repo: drey
priority: high
rank: 5000
branch: t/T-0042
entered-inbox: '2026-10-17T14:32:00Z'
entered-prioritized: '2026-10-17T15:01:12Z'
claimed-by: owner@desk
claimed-at: '2026-10-17T15:04:00Z'
references: ["t/T-0041", "https://github.com/HenrikPuls/Drey/pull/12"]
---

## Description

What and why, in plain Markdown. Links to notes, PRs, people.

## Plan

How. Authored at refine — the owner's hand or the shape dialog —
before the machine takes over; must end with the acceptance criteria.

### Acceptance criteria

- [ ] `npm run verify:unit` — exits 0
- [ ] `npm run verify:pack` — exits 0

## Log

- '2026-10-17T14:32:00Z' owner — created in inbox
- '2026-10-17T15:01:12Z' owner — inbox -> prioritized
- '2026-10-17T15:04:00Z' owner — claimed (build)
```

### Proof mode (E11)

A ticket's proof is **either** a UI walkthrough **or** test results —
never both, never neither:

- `ui` (the ticket changes what a user sees): the verify run records
  one walkthrough video (at most 60 seconds, chaptered per criterion)
  and at most six screenshots (`MAX_VERIFY_SHOTS`, a caption per
  criterion). The proof card shows the gallery and the player.
- `tests` (no UI change): no video and no screenshots — the test
  results alone stand in `## Verification`; the proof card hides the
  gallery and the player.

Who decides: the **builder** declares `proof: ui|tests` plus a
one-sentence reason in its `## Handover` (a fixed field; the build
prompt carries a paragraph asking for it). The **review** step
(Ralf's prompt) confirms or corrects the declaration. The ticket
frontmatter pin `proof:` (see Frontmatter fields) overrides both. A
missing or unreadable declaration reads as `ui` — the expensive, safe
default. The verify harness starts the app only for `ui`. This
supersedes the E4 "video on failure only" rule and concept v2's
"always".

### Parts (E10, concept v2 §5.9)

A plan that splits into parts lists them in an optional `### Parts`
chapter under `## Plan`, one `- [ ] <title>` checkbox per part in
execution order (the order IS the plan's order; moving a part is a
list edit). Each part's detail lines indent under its item: the
builder persona (`persona: ben`), the reason, and an optional
per-part `chain:` entry list in the chain delta grammar. The parts
become **their own tickets** when the owner approves the plan
("Start" in the Plan-to-approve card): each carries `parent: <id>`,
its own description, its own `persona:` pin and its own `chain:`
delta — the parent's `chain:` never leaks into a part. A part that
already runs is **locked**: the parts list refuses to move or delete
it, and no part may move ahead of a running one. The number of parts
follows the plan and is never fixed; one part means no `### Parts`
chapter at all ("Keep as one"). The parser is tolerant (an unreadable
line is skipped with a warning, never a guess).

The canonical shape (`core/plan-parts.ts`):

```markdown
### Parts

- [ ] Split a file diff into hunks
  persona: ben
  reason: pure logic first, so the panel can build on it
  chain: insert security(ralf, notify) after review; skip qa
- [x] Hunk rows in the Source control panel
  persona: ben
```

**Release (E10-4).** The owner's approval turns every part that has no
ticket yet into one (or only the first, "Run part 1 only"): the ticket
lands in the build queue (`created in <first phase>`, then `<first> ->
build` in its Log), named by the part's title, with `parent: <id>`, the
part's `persona:` pin, its own `chain:` entries, the parent's repo,
repos and priority, and `blocked-by:` the ticket of the part before it
(none for part 1), so the plan's order is the order of the work. A part
is matched to its ticket by title among the tickets that name the
parent. Every part that is a ticket is locked in the list. The release
is checked before it writes (persona files exist, each chain validates
against the build phase) and is one commit `tickets: <id> plan released
(<n> parts)`; the parent keeps its plan and gets one Log line, `plan
released: T-0131, T-0132`. A list edit (persona pick, move, delete) is
one commit `tickets: <id> parts` and keeps at least two parts.

`[x]` marks a part whose ticket was accepted. Detail keys are `persona`
(a persona id), `reason` (one line) and `chain` (entries of the
[chain delta](#the-chain-delta-e9-concept-57) grammar separated by `;`
— a `;` never occurs inside an entry). An unknown key, a bad persona or a
chain entry outside the grammar warns and drops. Moving a part is
`movePlanPart`, deleting `deletePlanPart`: both refuse a running part,
and `movePlanPart` refuses to put a part ahead of one that runs. Writing
the chapter (`withPlanParts`) replaces it in place or adds it at the end
of the Plan and removes it for fewer than two parts.

### Frontmatter fields

| Field | Shape | Rules |
|---|---|---|
| `id` | `T-\d{4,}` | Required. Must equal the filename stem. Immutable. |
| `title` | string | Required. One line, quoted when it contains `:`. |
| `repo` | string | Name from `_meta/repos.md`: the ticket's **primary** work repo (req-72) — where the fleet's gate runs and whose worktree is the run's home. May be empty until the ticket leaves inbox for a work phase; entering one without a known repo is an issue. |
| `repos` | list of names | Optional (req-72). Every work repo the ticket touches, **primary first** — `repos: [drey, lariscus]`. When set, the list is the truth and `repo:` repeats its first entry (a mismatch is a noise finding, the list wins). One worktree per named repo, all on the ticket's branch; a run refuses while any named repo lacks a local `path:` in `_meta/repos.md`. One or zero names write no `repos:` line. |
| `worker` | string | Optional pin for the fleet worker (M84): `opencode`, `claude-code`, or `<provider>/<model>`. Wins over the column's `worker:` key, the phase handover's `@worker` pin, the repo's `worker:` and the configured default (M85's assignment ring). An unknown value badges the card; a run start with it refuses. |
| `persona` | string | Optional persona pin (ADR-0088 E3): `persona: paul` — the top of the persona ladder, winning over the phase's `persona:` key and the engine default (`personas.default`). The persona's worker/model/prompt drive the dispatch; when nothing resolves or the persona file is missing the legacy assignment ring runs unchanged. See `_meta/personas/` below. |
| `awaiting` | persona id | Optional (E10-6). The ticket is **parked at a manual step** for that human persona (`awaiting: you`): the dispatcher never takes it (no run, no worktree) and it shows in Needs you as a `manual` card. Machine-written when a manual gate parks the ticket; **any transition clears it** (Accept or Send back are ordinary board moves, so is a hand move). See "The manual step" under the chain delta. |
| `priority` | one id of the board's configured vocabulary | Required. The vocabulary is the vault's own — `_meta/pipeline.md`'s `priorities:` list (default `urgent \| high \| normal \| low`); the list's order IS the weight, first = highest. An omitted or unknown id reads as the vocabulary's default (its middle entry) with a warning badge; machine writers always write a vocabulary word. See [Priorities](#priorities-priorities-in-pipelinemd). |
| `track` | `auto \| shape` | Optional (req-75 W1b, ADR-0087 decision 2). The ticket's triage track: `auto` runs on its own, `shape` goes through the plan-mode dialog with the owner. Absent (or any other value — a warning) reads as not triaged; set from the Work panel's row menu (Track ›) until W5c/W6 fill it from triage. |
| `form` | `ship \| scout` | Optional (concept §5.6, E8). The ticket's form: `ship` (the default — an absent key reads as ship) is the known way, plan → worktree → gate → move. `scout` is exploration only: a scout run reads repo/history/data and writes the ticket's `## Report` section — no worktree, no diff, no gate, no move; the report surfaces as a card in "Needs you" and the owner promotes the ticket to ship from there. Any other value warns (`form must be ship or scout — read as ship`) and reads as ship. See [The scout form](#the-scout-form-e8-concept-56). |
| `chain` | list of strings | Optional (concept §5.7, E9). The ticket's **delta** against the pipeline's standard flow — the standard flow itself is team configuration in `_meta/pipeline.md` and applies to every ticket silently; the ticket stores only the deviations, one declarative entry per item in the strict grammar: `insert <phase>[(<persona>[, notify] \| notify)] after\|before <anchor>` (add a gate at the anchor — a standard-flow phase may be revisited this way, at most once), `skip <phase>` (bypass a gate), `notify <phase>` (the notify rule: a card lands in "Needs you" when the gate completes), `move <phase> after\|before <anchor>` (a standard gate runs elsewhere, E10-5), `assign <phase> <persona>` (a standard gate's persona, E10-5); an inserted gate may be the manual step `manual` / `manual-<word>` (E10-6, see "The manual step"). Absent (or empty) reads as the standard flow. An entry outside the grammar warns and drops (`chain entry "<raw>" is not readable — expected e.g. "insert design after review"`). See [The chain delta](#the-chain-delta-e9-concept-57). |
| `parent` | ticket id | Optional (E10, concept v2 §5.9). Set on a ticket that is one **part** of a split plan: `parent: T-0130` names the ticket whose `### Parts` list produced it. The parent keeps the plan; the part carries its own description, builder persona and `chain:` delta (a per-part scope — the parent's `chain:` never leaks into a part). A value that is no ticket id, or the ticket's own id, warns and reads as no parent; whether the parent still exists is not checked (a finished parent is archived). |
| `proof` | `ui \| tests` | Optional pin (E11, concept v2 §5.3). Overrides the Handover's proof declaration (see [Proof mode](#proof-mode-e11)). Absent, or any other value (a warning), means no pin; with no pin and no readable declaration the mode reads as `ui`. |
| `rank` | integer 0-999999 | Default `5000`. Fine ordering inside derived order. |
| `branch` | `t/<id>` | Written by machine writers; validated against the rule; rule wins. |
| `entered-<phase>` | UTC timestamp | One per phase ever entered; holds the **most recent** entry time into that phase (first entry lives in git history). `entered-inbox` exists from creation. |
| `claimed-by` | `<who>@<host>` (agents append `:<session>`) | Set when the ticket enters a claim-flagged phase (default: build); `owner@<host>` for the human — `owner@<device>` (e.g. `owner@ipad`) when the action came from a paired remote device (req-66: the device name lowercased, reduced to `[a-z0-9-]`, `remote` when empty). Takeover overwrites and logs the old value. |
| `claimed-at` | UTC timestamp | Set with `claimed-by`. |
| `run` | map `{pid, started-at, stream}` | The live run (ADR-0075 run control): stamped by the fleet runner at start, cleared at end — at most one live run per ticket. `stream` names the **run id**; the stream file itself lives machine-local under `<userData>/fleet/runs/<id>/stream.jsonl`, so the ticket stays portable across the machines the repo syncs to. Readers validate the shape. |
| `references` | list of strings | Optional. Ticket ids (`t/T-0041`), URLs, vault paths. |
| `blocked-by` | list of ticket ids | Optional (T-0050). `blocked-by: [T-0048]` — the ticket waits until every referenced ticket reaches the pipeline's terminal phase. Blocked is **derived** on every board assembly, never stored. See [Dependencies](#dependencies-blocked-by). |
| `parked-reason` | string | With `parked-at`; the ticket sits in inbox while parked (circuit breaker, budgets — ADR-0075). Any transition out of inbox clears both. The circuit breaker writes them when it parks a column's next candidate (M85); re-prioritizing revives the ticket. |
| `parked-at` | UTC timestamp | See `parked-reason`. |
| `interactive` | boolean | The dialog reservation (req-65): `interactive: true` — the owner works this ticket in an interactive dialog with a fleet worker, so the dispatcher keeps its hands off while the field stands. An interactive run's start stamps it; any transition (a board move) drops it — at the new column the machine may take the ticket again. Only a bare `true` reads as set. |

Unknown keys are preserved on rewrite and reported as noise (not an
error). Human edits never break the file: what parses as YAML reads;
what does not is a badge.

### Dependencies (`blocked-by`)

A first-class dependency field (T-0050): "do not start before X is
done". The order it replaces used to live in prose, invisible to the
board and the fleet.- **Canonical syntax**: flow list with comma + space —
  `blocked-by: [T-0048]`, `blocked-by: [T-0048, T-0049]`. The parser
  accepts every YAML list shape (block style, any spacing); a
  hand-written no-space list (`[T-0048,T-0049]`) is normalized
  cosmetically on the next machine rewrite, while the canonical form
  round-trips **byte-stable** through a transition's frontmatter
  rewrite. An empty list reads as an absent field.
- **Satisfied phase**: one global rule — a reference is satisfied
  exactly when the referenced ticket sits in the pipeline's terminal
  (last) phase. No per-reference override.
- **Derived, never stored**: every board assembly recomputes each
  card's `blocked` (the open blockers, unknown ids included) and the
  inverse `blocks` (the currently-blocked dependents). Both hide when
  empty — a done blocker shows nothing. A blocker in an unknown
  directory resolves by its stripped phase id, never terminal, so it
  blocks. `tickets/archive/` is not read: a blocker deleted, renamed
  or archived resolves to no board ticket and no longer blocks (owner
  decision 2026-10-31: archiving a finished blocker must not stall a
  chain).
- **Validation**: an id that resolves to no board ticket gives no
  finding and does not block. Self-reference and cycles are one error
  per member naming the cycle (`blocked-by cycle: T-0001 -> T-0002 ->
  T-0001`; self = `T-0001 -> T-0001`) — cyclic members also count as
  blocked. Duplicate blocker ids (themselves already an error) resolve
  to the first occurrence in column order.
- **Enforcement**: exactly the machine gates — the dispatcher never
  picks a blocked ticket, the manual "Run agent…" start refuses with
  the open blockers named, and the ci sweep skips it (a blocked ticket
  does not move through a `ci` column either). Human moves stay free;
  an owner move into an agent phase asks for confirmation naming the
  open blockers (the owner is the final authority). The Work panel
  (req-75 W1) shows `Blocked by <ids>` as the row's status line;
  ordering is never touched. The drift
  pass (normalization) never enforces blocked-ness — a file move is an
  owner move.
- **Editing** (the chat/edit path): the whole list is replaced in one
  step, never a partial edit — the chat's `setBlockedBy` command (a
  proposal card like every chat mutation, concept §6; an **empty list
  clears the blockers**) and the engine's `setBlockedBy` write both run
  one header rewrite, one Log line (`blocked-by <n> ids`, or
  `blocked-by none` when the list empties and the key leaves the file)
  and one commit `tickets: <id> blocked-by <n ids|none>`. An unchanged
  list is a no-op; a live run refuses, like every header edit. Ids are
  checked against the ticket grammar at write time; whether they
  resolve on the board stays the dependency pass's business — an
  unknown id is written and simply never blocks.

### Priorities (`priorities:` in pipeline.md)

The vocabulary is the vault's own (weight order, first = highest):
`_meta/pipeline.md`'s top-level `priorities:` list, defaulting to
`urgent | high | normal | low` when absent or unreadable. Every
`priority:` in a ticket carries one of its words; an omitted or unknown
id reads as the vocabulary's **middle entry** (the default) with a
warning. The split rule everywhere is the middle's (`floor(len/2)`):
the entries before it are the fleet dispatch's **jump class** (req-63),
the entry at it is the **default**, the entries after it are the calm
half. The same list drives the board's derived column order, the
dispatch classes, the chat (the digest names it; the mission's
`setPriority`/`createTicket` priority fields validate against it) and
every header edit's priority guard (`setPriority`, the remote refine,
the raw-edit save, `createTicket` — a foreign word refuses with a
readable error instead of being written).

### Body sections

Free Markdown; the section headings below are convention that Drey and
the runner rely on.

**Fenced code is opaque to every ticket parser** (E10-7, milestone 148).
A Mermaid diagram (or any fenced block) may sit anywhere in the body —
under the description, between `### Goal` and `### Parts`, inside the
Handover — and its lines never count as structure: a `## Verification`,
`### Parts`, `- [ ] step`, `persona:` / `chain:` detail, `proof:` line,
Log line or `---` inside a fence is text. The rule is one shared reader,
`shared/markdown/fences.ts`: a fence opens on three or more backticks or
tildes (after indentation, a list marker or a `>` quote), carries no
backtick in a backtick fence's info string, and closes on the same
character at least as long; a fence that never closes ends at the next
`## ` heading in column 0, so a forgotten closing fence cannot swallow the
Verification and Log chapters. Writers slice the original text around the
chapter they own, so a fence inside any other chapter survives byte for
byte (a chapter that is replaced as a whole — the Plan on a shape reply —
replaces its fences with it). The status log, the personas and the chat
sessions are own line grammars, not ticket documents, and not covered.

- `## Description` — what and why. The capture text lands here.
- `## Plan` — how; authored at refine (the shape dialog or the
  owner's hand) and completed by the build step at run time (req-93:
  the build derives file-level detail itself, against the code it
  finds). A ticket without backticked acceptance criteria under the
  plan cannot run — the fleet refuses the start.
- `### Acceptance criteria` — under Plan. Checkbox lines whose text
  starts with a backticked command; the machine gate runs exactly
  these, locally, in the worker's checkout (ADR-0076: validator, not
  CI).
- `### Parts` — under Plan, optional (E10): the split plan's parts as
  checkboxes; see [Parts](#parts-e10-concept-v2-59).
- Handover `### Review feedback` — the owner's line comments from a
  send-back (E11-3, owner decision D6): one line per comment,
  `- \`<path>:<line>\` — <text>` (a range reads `<path>:<first>-<last>`;
  lines are the NEW file's). The engine writes the block into
  `## Handover` in the same commit as the send-back move and replaces an
  earlier block; the build prompt tells the persona to treat each line
  as a requirement of the round. A send-back may carry comments instead
  of a note (the Log line then reads `sent back: n review comments`).
- Handover `proof:` — the builder's one-line declaration
  `proof: ui|tests — <one-sentence reason>` (E11); see
  [Proof mode](#proof-mode-e11). A `## Verification` section of a `ui`
  ticket may carry a `### Video` chapter (`![](../videos/<name>)`) and a
  caption per screenshot; a `tests` ticket carries neither.
- `## Report` — the scout run's finding (concept §5.6, E8), an
  exploration ticket's endpoint; ship tickets never carry one. The
  **scout run** writes it into its own ticket file, **replaced** on
  every scout run (never a second section of the name, before `## Log`
  like every other chapter). The canonical shape:

  ```markdown
  ## Report

  Written on 2026-11-02T14:32:00Z by paul.

  ### Summary

  The repo carries two index implementations; only SQLite is wired
  into the build.

  ### Decisions

  - [ ] D1: Which storage should back the index? — Recommendation: SQLite, the repo already ships the helper.
  - [x] D2: Migrate existing data? — Recommendation: yes, one migration script.
  ```

  The stamp line names the UTC time (seconds precision) and the
  writing persona. `### Summary` is the free-text answer; `###
  Decisions` lists the choices only the owner can make — one line per
  decision, `- [ ] D1: <question> — Recommendation: <rec>` (em-dash
  prefix exactly; the recommendation may be absent), keys in order,
  flipped to `- [x]` by the owner as decisions are made. The whole
  `### Decisions` block stays absent when nothing is open. The engine
  reads the section tolerantly (`core/scout.ts`, the asymmetric-
  tolerance rule): an absent or partially unreadable section means
  "no report yet", never a guess. The engine raises the parsed report
  as a card in "Needs you" (`kind: report`); a promoted ticket keeps
  the section as history.
- `## Changes` — what the Ready page shows (req-75 W3, ADR-0087
  decision 3). The **build worker** writes or updates it before it
  ends — the section is the contract, no diff parsing on the desk —
  and the page (`packages/tickets-engine/src/contracts/changes.ts`, re-exported by `plugins/tickets/shared/changes.ts`) reads it
  tolerantly: labels case-insensitive, `-`/`*` bullets, missing parts
  simply left out. The exact format the worker keeps:

  ```markdown
  ## Changes

  **What changed for you:** The command palette opens once, even when Ctrl+P is pressed twice quickly.
  Nothing else you can see has changed.

  **Where:**
  - M `src/app/palette/palette.service.ts` — a second open while one is opening is ignored
  - A `src/app/palette/palette.service.spec.ts` — two new tests for the double press

  **Checks:**
  - 412 tests passed, lint, the four typechecks, import cycles

  **How to try it:** 1. Launch this version · 2. Press Ctrl+P twice, fast · 3. One palette opens
  ```

  Status letters are `A` (added), `M` (modified), `D` (deleted), `R`
  (renamed); a path without a why is fine. The page also reads the
  ticket's story ("How it got here") from the Log section alone — no
  frontmatter is added for any of this.
- `## Result` — the closing report (req-86). The **commit step** writes
  it after the merge: three to six plain lines for the owner — what
  landed (merge commit, branch), what they can now see or do
  differently, anything left over. Free text under the heading
  (`parseResult`); the final card shows it first, as "What was
  delivered". Absent, the final card shows `## Changes` alone.
- `## Handover` — what a step leaves for the next one and for its own
  resume (milestone 94). The worker **replaces** the section (never a
  second one, before `## Log`) at the end of every step: `State` (`done`
  or `blocked`, one line), `Decisions` (up to three bullets), `Open`
  (what the next step must check first), `Files` (the main ones),
  `Verified` (commands run and their result), under 15 lines. The next
  step's brief and a resume carry it (capped at 2 KB) instead of the Log
  tail; `ticketSections` reads it. A Log line stays one short line under
  200 characters — detail belongs here.
- `## Verification` — the verify run's proof (E4, ADR-0088 later
  change). Written by the engine's verify step, **replaced** after every
  run (never a second section, before `## Log`). The canonical shape:

  ```markdown
  ## Verification

  Tested on 2026-11-01T14:32:00Z by verify@engine — Electron 34.2.0 on win32.

  ### Criteria

  - [x] `npm run build` → ![](../attachments/verify-20261101-143200-01.png)
  - [ ] `npm test` — no screenshot: the app never became ready

  ### Findings

  - The settings page stayed blank until the reload.
  ```

  `### Criteria` carries one `- [x]` / `- [ ]` checkbox per acceptance
  criterion — the backticked command exactly as written under the Plan —
  and, when the run captured one, the screenshot proof as
  `→ ![](../attachments/<name>)`; `### Findings` lists
  what the runner noticed beyond the criteria and is omitted when empty.
  The screenshot files live in `tickets/attachments/` (the `verify-…`
  names are the runner's; `img-…` stays the phone's). A `ui` proof
  (see [Proof mode](#proof-mode-e11)) adds a `### Video` chapter between
  Criteria and Findings: the player `![](../videos/<name>)` and one
  `- m:ss <criterion>` chapter line per shot (the offset is seconds from
  the recording's start); when the recording was over the per-video
  cap (see [Videos](#videos)) the chapter is the single line
  `Video not kept: 31 MB exceeds the 25 MB limit.` instead.
  Older tickets may still carry the retired `Video removed (size
  limit).` line; the reader ignores it. A `tests` proof
  has no shot, no `### Video` and marks every criterion
  `- [x] \`cmd\` — checked by the machine gate` (no app was started; the
  gate that let the ticket reach the verify phase stands in). The proof card
  reads the section tolerantly (`core/verification.ts`); an absent
  section means "not verified yet". The engine's verify step is a
  machine step, not an agent run: it launches the ticket worktree's
  built app (repos.md `launch:`, else the `dev.ps1 -Built -Multi`
  convention), walks the criteria headless, persists the section and
  moves the ticket to the owner's checkpoint.
- `## Log` — append-only. Machine-appended entries use the exact line
  shape `- '<UTC timestamp>' <who> — <text>`; humans may append in any
  readable shape. Every transition, claim, takeover, injection, stop
  and budget event lands here (ADR-0075). A ticket created from a
  tidied capture (req-75 W5c) carries a `raw capture:` Log line with
  the owner's original words, right after `created in`.

### The scout form (E8, concept §5.6)

A `form: scout` ticket runs **only an exploration**. A scout run
(the `scout-default` prompt, concept §5.6) sends a persona reading
repo/history/data — no worktree is prepared, no branch is cut, no
gate runs, no move happens, and the acceptance-criteria hold (check
9) is a ship-form requirement: the scout run's only write is the
`## Report` section into its own ticket file, which the runner
commits. The run's endpoint is not a proof but the report as a card
in "Needs you".

**Promotion** is the owner's move from that card — the Mission
Control chat's `promote` command ("promote T-0004"), proposed as a
card and executed only on the owner's confirm (concept §6: the chat
never writes on its own). The board half is one header rewrite
(`form: scout` → `form: ship`, `patchForm`), one Log line
`- '<UTC>' <actor> — form ship`, and exactly one commit
`tickets: <id> form ship`; it refuses while a run is live on the
ticket and is a no-op success when the file already carries the
value — the mirror of `track` in every way. Setting a scout ticket
back to ship by hand is the same header edit; the machine shape
above is what the board writes. From its next normal run the
promoted ticket is an ordinary ship ticket: plan, worktree, gate.
The `## Report` section stays in the file as history.

### The chain delta (E9, concept §5.7)

The pipeline's standard flow is **team configuration**
(`_meta/pipeline.md`) and applies to every ticket **silently**. A
ticket stores only its **delta** — declarative entries in the
frontmatter's `chain:` list:

```markdown
chain:
  - insert security(ralf, notify) after review
  - skip verify
```

The engine merges standard + delta into the ticket's concrete
chain, from which the gate bar, the notify cards and the chat's
before/after confirmation render. No second source of truth, no UI
state — the chain is data in the ticket. The merge is read-tolerant
(an unknown phase renders with its id as title, an unknown anchor
appends at the end); **writes** are guarded semantically.

The grammar, one entry per list item:

- `insert <phase>[(<persona>[, notify] | notify)] after|before
  <anchor>` — adds a gate at the anchor phase. A phase the standard
  flow already contains may be inserted — a **front-loaded revisit**
  — at most once per phase. The persona pins who works the gate
  (absent = the ladder decides); `notify` is the notify rule (see
  below).
- `skip <phase>` — the ticket bypasses the gate (rendered struck).
- `notify <phase>` — the **notify rule** on a standard gate: a
  card lands in "Needs you" when the gate completes. The card shows
  from the gate's completion until the ticket leaves the following
  gate or the freshness window (`NOTIFY_WINDOW_MS`, 24 h) runs out,
  whichever comes first.
- `move <phase> after|before <anchor>` — a standard gate runs
  somewhere else in this ticket's chain (E10-5, the flow editor's move
  earlier / later). Once per phase; an inserted gate is moved by
  changing its own insert, never by `move`.
- `assign <phase> <persona>` — pins who works a standard gate
  (E10-5). An inserted gate carries its persona in the insert.

**The manual step (E10-6).** A gate the owner works by hand. Its phase id
is `manual` (a second one `manual-<word>`, e.g. `manual-qa`) — the only
phase ids the chain accepts that are **not** a pipeline directory — and it
exists only as an `insert`:

```markdown
chain:
  - insert manual(you, notify) after review
```

The persona is the **human** persona (`kind: human`, below); without one the
step is the owner's anyway (`you`). A pinned **agent** persona is refused at
the write guard (the flow service) and ignored by the dispatcher. It anchors
on a real phase, is inserted at most once per id, and nothing anchors on it
or moves it; `skip`/`assign` on it are refused (the existing "inserted"
rules).

*Parking.* When the gate before the manual step finishes green, the run does
not move the ticket on: it stamps `awaiting: you` where the ticket sits (a
ticket the dispatcher pulled across a checkpoint moves into the working
column first), appends one Log line (`parked for you (manual step)`, actor =
the fleet) and the status log's `done:` line names who waits. No agent runs
for the step and no worktree is prepared for it. The same park happens for a
gate the human persona **works itself** — the delta's `assign`/insert pin,
else the ticket's `persona:` pin, else the phase's `persona:`, else the
engine default resolves to a `kind: human` persona: the dispatch pass
stamps `awaiting` instead of composing a run (once; `paused:` status line,
Log line `parked for <name> - the <phase> gate is a manual step`).

*Finishing.* **Accept** is the board's ordinary accept — the ticket moves to
the next phase, the field goes (Log line `manual step finished by <owner>
(<persona>)`, the status log's `done:` line with the owner as actor, one
commit). **Send back** is the ordinary send-back (nearest earlier agent
phase, the mandatory note, the structured feedback of E11-3). Neither needs
a new endpoint. The Needs-you list raises a `manual` item for every
`awaiting` ticket (it replaces the checkpoint item when both would apply).
The human persona never takes a pool slot, never appears in the capacity
or stuck figures and carries no budget.

A split ticket's **parts** each carry their own `chain:` delta (E10): the
scope is the part, never the parent. A part's chain flows from the build
gate on (the part's builder is the persona on the plan card, so the build
gate itself is not editable in a part's flow).

**The flow editor (E10-5).** Mission Control edits the chain as *steps*, not
as strings: an insert after a gate, a removal (a strike for a standard gate,
dropping an insert), a restore, move earlier / later, a persona, the notify
rule, a reset to the standard flow. Every edit takes the draft delta and
returns the next one (`core/flow-edit.ts`, `applyFlowOp`); the delta is
regenerated canonically from the edited arrangement — standard gates that
kept their relative order stay silent (the longest in-order run), the
others get `move`, new gates `insert`, then `skip` / `notify` / `assign`
follow — and is checked by merging it back to the same arrangement, so an
arrangement the grammar cannot write (two gates of one phase make an
anchor ambiguous) is refused with a reason instead of written wrong. Only
the future is editable: the current and past gates are locked (a running
gate stays as it is). Nothing is written before "Save flow": ticket scope
goes through `setChain` (one commit `tickets: <id> chain <n entries|
standard>`), part scope rewrites that part's `chain:` line in the parent's
`### Parts` (one commit `tickets: <id> part <n> flow`); a part that is a
ticket already, a live run and a delta the guard rejects refuse.

Phase ids are the pipeline's id grammar (`[a-z][a-z0-9-]*`),
persona names bare lowercase words.

**The write guard** (`validateChain`,
`packages/tickets-engine/src/core/chain-delta.ts`) runs where a
write is decided — the board service's `setChain`, the chat
command's execution — never on render. It refuses, with the reason:
a phase or anchor the pipeline does not contain; a phase anchored
on its own insert; a phase inserted twice; a phase both skipped and
inserted ("strike the gate or revisit it, not both"); a skip,
anchor or notify of the current or a past gate (the delta only
reaches future gates); a `move` of a current, past, inserted, skipped or
already moved gate, onto itself, or ahead of the current gate; an `assign`
of a current or past gate, of an inserted gate or twice.

**The machine write** is the chat's `setChain` command (concept §6:
the change runs through the chat as a command **with confirmation**
— the proposal card shows the chain before/after and executes only
on the owner's confirm). The board half is one header rewrite
(`patchChain`), one Log line — `chain <n> entries`, or
`chain standard` when the delta goes away (the key is removed) —
and exactly one commit `tickets: <id> chain <n entries|standard>`.
It refuses while a run is live on the ticket and is a no-op success
when the file already carries the delta — the mirror of `track` in
every way. Setting the delta by hand is the same edit — frontmatter
plus the Log line; the machine shape above is what the board
service writes.

### The fleet ledger (E7)

`tickets/_meta/ledger.jsonl` — the fleet's events as one strict JSON line
each, append-only, swept into git by the next regular commit (never
committed per line). The reader skips a line it cannot parse. Shape:
`{"v":1,"ts":"<UTC>","event":"<kind>","ticket":"T-0002", …}` with
`persona`, `model`, `cost` (USD, four digits), `tokensIn`, `tokensOut`,
`from`, `to` present only where the event knows them. Kinds:
`dispatched` (persona and model the dispatch resolved), `phase`
(`from`/`to`), `proof_ready`, `merged`, `archived` and `run_settled`
(one line per completed run with its effective tokens and cost — the
source of the ticket cards' cost and the persona day budgets).
`phase`, `merged` and `archived` carry no persona, model or cost.
The code is `core/ledger.ts` (`LEDGER_FILE`).

### The ticket status log (E7)

`tickets/<phase>/<id>.status.log` — one machine log per ticket, in the
ticket's current phase folder, beside the `<id>.md` file it mirrors.
It is the fleet's and the engine's single source for "whose turn /
what blocks"; the UI reads projections from it, never free text.
**Append-only**: ONE line per event, machine shape
`- '<UTC timestamp>' <verb>: <payload>`, the verbs:

- `working:` — what the run does now.
- `needs-decision: [<short-key>] <the question, with a recommendation>`
  — waits for the owner.
- `blocked: [<short-key>] <what holds the run>`.
- `paused: <reason> until <time>`.
- `resolved: <key>` — the owner answered / the blocker cleared; the
  payload IS the key.
- `done:` — the step handed over.
- `failed: <why>`.

Every `needs-decision` and `blocked` **carries a key** — a short
lowercase slug (`[palette-shortcut]`) — because the key is how the
owner answers: an open key stays on the owner's desk (the Needs-you
list raises one card per open key) until a `resolved:` line naming it
closes it. Newer lines never close a key implicitly; a keyless line
is its own item, surfaced visibly instead of matched. Writers append
their own lines only — an older line is never rewritten or reordered;
readers are tolerant (a broken line is skipped, never guessed). The
log is plain text a human may read and append; it never lives inside
the ticket file, and the ticket file never embeds it.

## `_meta/pipeline.md` — the phases and their handovers

```markdown
---
push: origin
phases:
  - { id: inbox, title: Ideas, handover: manual }
  - { id: prioritized, title: Prioritized, handover: manual }
  - { id: build, title: Build, wip: 3, claim: true, handover: agent build-default, color: '#c96442' }
  - { id: commit, title: Commit, handover: agent commit-default }
  - { id: done, title: Done, handover: none }
---
Prose for humans. The board follows this file on refresh.
```

- `id`: `[a-z][a-z0-9-]*`, unique, = the phase (the stripped directory
  name). The first phase is the capture target; the last is terminal —
  nothing moves out of it. Humans always may move tickets into it, and
  so may the machine from an agent-driven column whose next phase it is
  (owner ruling 2026-10-19: the commit column's agent pushes the work
  onto the integration branch, then the ticket goes `commit -> done`).
- `title`: board column header.
- `wip`: optional integer. Over-limit shows red on the board
  (`4/3`); it warns, it does not block a human (and it never gates the
  dispatcher — the provider pools are the parallelism, req-63).
- `claim`: optional `true` — entering this phase stamps the claim
  fields.
- `handover`: what must happen for a ticket to LEAVE this phase:
  `manual` (a human moves it), `agent <prompt-ref>[@<worker>]` (the
  fleet runs prompt `<prompt-ref>` — `tickets/_meta/prompts/<ref>.md`
  in the tickets repo — and the runner moves it on success; the
  optional `@worker` pins which agent CLI, otherwise the assignment
  ladder decides), `ci` (an executable check passes — the phase's
  `ci:` command, run runner-side in the ticket's work repo since M85),
  `none` (terminal). A column is **automatic** exactly when its
  handover mode is `agent` (M85's dispatcher drives it); `manual`
  columns are the human's.
- `push`: optional (T-0041) — the **name of a git remote** (from git
  config; never a URL). When set, every transition commit (a board
  move, a normalization move, an archive, the runner's success move)
  is pushed: `git push <remote> HEAD` from the tickets repo root.
  Default off; a push failure is a warning (board) / log line
  (runner), never a failed transition. Anything but a remote-name
  string is ignored with a noise badge.
- `interactive`: optional prompt ref (req-65) — the brief an
  **interactive dialog run** in this column gets
  (`interactive: plan-interview` → `tickets/_meta/prompts/plan-interview.md`).
  Absent, the shipped default applies: `plan-interactive-default` on the
  pipeline's first automatic column (E13-9 removed the `refine-interactive-default`
  twin and the "Refine with agent" start of the manual columns; shaping an
  idea is the ticket file plus Mission Control; automatic columns offer no
  dialog, the runner works them). An interactive run is started
  from the board ("Plan with agent"), not by the
  dispatcher: the worker is the owner's from turn one (held), the run
  never gates and never moves — the dialog's end moves (in the takeover
  tab) are owner moves. While the run is live the ticket carries
  `interactive: true`, which keeps the dispatcher off it; the move
  drops the field.
- `persona`: optional persona id (ADR-0088 E3) — the ladder's middle
  level: every ticket of this column dispatches with this persona unless
  the ticket pins its own. For the run the persona's worker and model
  replace the assignment ring's resolution and the persona's `prompt.md`
  becomes the instruction base instead of the phase handover prompt.
  See `_meta/personas/` below.
- `priorities:` optional top-level list — the board's priority
  vocabulary, in weight order (first = highest). Every ticket's
  `priority:` must carry one of its words; an omitted or unknown id
  reads as the list's **middle entry** (the default) with a warning.
  The split rule is the middle's, everywhere (`floor(len/2)`): the
  entries **before** it are the fleet's jump class (req-63), the entry
  **at** it is the default, the entries **after** it are the calm half.
  Unreadable entries (not an id, a duplicate) drop with a noise badge;
  an empty or unreadable list falls back to the shipped
  `urgent | high | normal | low`. The vocabulary drives everything that
  reads a priority — the board's derived column order, the dispatch
  classes, the chat (the digest names it, the mission's priority fields
  are validated against it) and every header edit's priority guard —
  there is no hard-coded list left in the paths.
- Editing this file is the owner's; the board re-reads it on every
  refresh. Unknown keys in a phase entry are ignored.

**Pool keys** (M85, ADR-0077 — the settings dialog writes them with one
commit per change; hand edits win on refresh):

- `worker:` — the column's worker pin (`opencode`,
  `claude-code`, `<provider>/<model>`), the assignment ladder's column
  level (ticket pin > column > handover `@worker` > repo default >
  configured default). Unset on a manual column. **Deprecated with
  personas (E3):** stays readable until the board service migrates the
  column onto a persona, then is rewritten to null — the ladder decides
  from then on.
- `model:` — the model pin for the column's runs (OpenCode:
  `providerID/modelID`). **Deprecated with personas (E3):** readable
  until migrated onto the persona's `models`, then cleared to null.
- `workers:` — **retired (req-63).** The parallel slots belong to the
  worker providers (`fleet.pool.<provider>.size` in the plugin config,
  Settings → Tickets → Workers, req-71), shared by every column. A leftover key is
  ignored with a noise badge; clearing a column's worker removes it.
- `prompt:` — the prompt ref override; the default is the handover's
  ref (and setting a worker in the dialog writes the matching
  `agent <phase>-default` handover, clearing it writes `manual`).
  **Deprecated with personas (E3):** readable until migrated — the
  persona's own `prompt.md` carries the prompt from then on — then
  cleared to null.
- `max-red:` — the circuit breaker's tolerance: consecutive red gates
  the column takes before it trips (holds + parks its next candidate
  in inbox). Default 3.
- `max-turns:` / `max-work:` — the column's own run ceilings (milestone
  96): the most model turns, and the most working minutes (busy time —
  a wait for the owner does not count), one run of the column may take
  before the lease reaper stops it and the step fails into the back-off.
  Positive integers; absent or invalid = the runner's defaults (250
  turns, 90 minutes).
- `token-budget:` — the column's daily token budget (the pool's settled
  runs are summed per day); over budget trips the breaker. Off by
  default.
- `ci:` — the `ci` handover's executable check (a shell command, run in
  the ticket's work repo checkout); a green check moves the ticket one
  column right, a red one backs the ticket off for ten minutes.
- `audit:` — a fraction 0–1: a green step is sampled and a fresh second
  worker reviews it before the move. Default off.
- `semantic: true` — every green step in the column gets a second
  worker's review before it moves. Default off.
- Columns are added, renamed and removed in Settings → Tickets →
  Pipeline (req-86): an add writes `{ id, title, handover: manual }`
  (the id derives from the title, a clash takes `-2`), a rename changes
  `title` only — the id, the folder and every ticket stay — and a remove
  is refused while tickets sit in the column; the first and last
  phase are never removed.
- `color:` — optional `#rrggbb`. The Work panel's phase chip uses it;
  without it a curated default palette colours by position.

**Agent lane rules** (enforced by the runner, not the board — the
board serves the human): an agent works the tickets the dispatcher
gives it — the column's own queue first, then the previous column's
top — and a dispatched run's completion moves the ticket from where it
sits to the **working column's next phase** (a pulled ticket goes
`prioritized` → `commit` in one step). A manual column between
automatic columns is the owner's **checkpoint**: the machine never
pulls across it, and only the owner's moves cross it (refine /
implement / park). Backward moves are human moves — the one exception
is the circuit breaker's park into inbox, always logged.

**Dispatch order** (req-63): one candidate list over every playing
automatic column, ordered by priority class (the configured
vocabulary's first half before its second — see `priorities:` above),
then column rank — the rightmost column first, so
finishing beats starting — then the column's derived order. Each candidate takes a slot of the provider pool its
assignment resolves to; a full pool makes it wait, a running run is
never preempted.

## `_meta/personas/` — the agent personas (E3)

A persona is a named agent — role + behaviour + model + memory in one
directory (ADR-0088 E3). One folder per persona, directly under
`tickets/_meta/personas/`:

```text
tickets/_meta/personas/
  paul/
    persona.md        # frontmatter: title, kind, role, worker, models, color, skills, budget
    prompt.md         # the persona prompt — the run's instruction base when present
    memory.md         # curated memory (format and cap below)
    thread.md         # the coaching thread — the owner's chat with the persona (U4)
    friction.md       # the worker's findings (E6 — format below)
    improvements.md   # the aggregation's proposals (E6 — format below)
    avatar.png        # optional
```

- The persona id **is** the folder name: lowercase letters, digits and
  dashes, at most 64 characters (`paul`, `build-opus-1m`).
- `persona.md` frontmatter fields (tolerant parse — what parses reads,
  the rest falls back to these defaults):

  | Field | Shape | Default |
  |---|---|---|
  | `title` | string | the id |
  | `kind` | `agent \| human` | `agent` (an absent key). `human` is the owner as a team member (E10-6): `personas/you`, created once by the board service (title = config `personas.humanName`, default `You`; editable like any title). Inert for `role`/`worker`/`models`/`skills`/`budget` — the human is never dispatched, counted toward capacity or budgeted. Written only when `human` |
  | `role` | `planner \| builder \| reviewer \| tester \| custom` | `custom` |
  | `worker` | the CLI harness (`claude-code`, `opencode`, `api`) | `opencode` |
  | `models.default` | the model nothing else decides | `opus` |
  | `models.pool` | allowed models; the order is the fallback order on rate-limits/outages | `[models.default]` |
  | `models.router` | `off \| budget \| escalate-on-fail` — a router only ever picks inside the pool | `off` |
  | `color` | `#rrggbb`, the chips and avatars | `#a78bfa` |
  | `skills` | reusable skill files under `_meta/skills/` the persona carries | `[]` |
  | `budget` | USD per day — the Team card shows the day's costs against it | unset (null) |

- `prompt.md` — the longform persona prompt, free Markdown. When a
  persona resolves at dispatch, this file is the run's instruction base,
  replacing the phase handover prompt.
- `memory.md` — the persona's curated memory. Created on first write with
  a `# Memory` header; **capped at 200 lines**, the oldest lines drop off.
  One entry per line:

  ```markdown
  - <YYYY-MM-DD> · <ticketId> · <lesson>
  ```

  Two writers append (a writer never rewrites existing entries): the
  fleet settles a persona run with its outcome line — the outcome word
  (`handed-over` / `failed` / `stopped`) plus the token count; a memory
  write failure is logged and never fails the settle. And the board
  service's confirmed `personaLearn` entry is the owner's hand-confirmed
  lesson, one line per call, committed once as `personas: <id> memory +1`.
  The run brief's context pack carries a slice of this file — the last
  ~20 lines / ~500 tokens, whichever is smaller, under a `## Memory`
  heading with a one-line explanation; an absent file adds no section at
  all.

  A pinned entry (U4 — the owner keeps the asset curated) carries a
  trailing ` [pinned]` marker on its line; the pin toggle adds or strips
  exactly that marker, one commit `personas: <id> memory
  pinned|unpinned`. An entry's index in `GET /api/personas/<id>/memory`
  is its position in the file's entry list (oldest first).

- `thread.md` — the coaching thread (U4, concept §4.5): the owner's chat
  with the persona, one file, shaped like a `_meta/chat/` session —
  created on first append with `title`/`created` frontmatter, one message
  per line below:

  ```markdown
  - '<ISO-8601>' owner — <one line of coaching>
  ```

  The writer is strict (a multi-line message flattens to one line); the
  reader forgives — an unparseable line is skipped, never guessed. Every
  append is one commit `personas: <id> thread`. The run brief's context
  pack carries the last 5 messages, newest first, under a `## Coaching`
  heading, so what the owner taught in conversation reaches the next
  dispatch; an absent or empty thread adds no section at all.

**The improvement loop (E6).** Two more files may live in the persona
directory — the worker's findings and the aggregation's proposals (the
format's grammar lives in the engine's `core/improvements.ts`, the
trigger and the owner's apply in
[ADR-0088](../docs/09_architecture_decisions/0088-tickets-engine-package-cut.md)'s
E6 record):

- `friction.md` — the worker's write path, created on first append; one
  finding per line, nothing else:

  ```markdown
  - <YYYY-MM-DD> · <ticketId> · <what was missing>
  ```

  The ticket id may stay empty. The reader tolerates the rest — an
  unparseable line is skipped, never guessed. The build / review / qa
  prompts ask the worker for one line per finding (lacked context,
  guessed a convention, the same obstacle twice); no persona in the
  brief, no line. Lines move out of this file on aggregation — what the
  aggregator consumed into a proposal's evidence does not stay behind.
- `improvements.md` — the machine's half of the owner's 1:1, strict
  writer / tolerant reader; an absent or broken file reads as empty, the
  caps (`MAX_IMPROVEMENT_EVIDENCE` = 10 items, `MAX_IMPROVEMENT_CONTENT`
  = 8 KiB per proposal) keep a phone review small. The shape:

  ```markdown
  # Improvements — paul

  - aggregate: '2026-11-02T10:00:00Z'

  - imp-1 open prompt.md — Order the context pack by name
    - proposed: '2026-11-02T10:00:00Z'
    - evidence:
      - 2026-11-01 · T-0007 · guessed the order.md shape
    - lesson: Keep the pack recipe explicit.
    - content:
        You build in the ticket's worktree …
  ```

  The `- aggregate:` stamp marks the last aggregation run (absent when
  never). Each proposal is one `- imp-<n> <state> <target> — <title>`
  block: the states are `open | accepted | dismissed` — a decision adds
  the `- decided:` stamp, never rewrites the block's history; the
  targets are `prompt.md | models.default | memory`, the file the
  owner's Apply rewrites; `evidence:` carries the friction lines the
  draft was read from; a `- lesson:` line rides only when the proposal
  brings one. Ids are minted per persona file and never reused. The
  trigger's constant is `IMPROVEMENTS_THRESHOLD` = 3.

**The resolution ladder** — three levels, first hit wins:

1. the ticket's `persona:` frontmatter pin,
2. the phase's `persona:` key in `pipeline.md`,
3. the engine default, the config key `personas.default`.

A resolved persona drives the dispatch: worker and model come from the
persona (the model from `models.default`, a router only climbs inside
`models.pool`) and `prompt.md` replaces the handover prompt. When nothing
resolves, or the persona file is missing, the legacy assignment ring runs
unchanged — a board without personas behaves exactly as before. Every run
records the resolved id in its `RunInfo.persona` (null on ring
dispatches), which is also the key the token report's per-persona cost
grouping aggregates under (`unassigned` for persona-less runs).

**Migration of the legacy column keys.** The phase-level `worker:` /
`model:` / `prompt:` pool keys stay readable until the board service
migrates a column: on a snapshot that sees any of the three keys, the
service writes the generated persona (`persona.md` + `prompt.md`, seeded
from `tickets/_meta/prompts/<prompt-ref>.md` when that file exists, an
empty `prompt.md` when it does not) under the derived id
(`personaMigrationFor`), rewrites the phase with `persona: <id>` and the
three legacy keys cleared to null, and closes with exactly one commit
`tickets: personas migrated`. The pass is idempotent — a pipeline
carrying no legacy key is left alone — and announces like every other
board write. After the migration the ladder decides; the legacy keys are
never written again.

## `_meta/order.md` — retired (req-75 W1)

The sparse per-column order pins went with the kanban board
([ADR-0087](../docs/09_architecture_decisions/0087-work-panel-replaces-the-kanban-board.md)).
Nothing reads or writes `order.md` any more: a column's order is the
derived order (priority, then `rank`, then `entered-<phase>`, then
id), and the Work panel sorts Ideas by priority, newest first within one.
An existing file is left alone — delete it by hand when convenient.

## `_meta/repos.md` — work repositories

```markdown
---
repos:
  drey:
    url: https://github.com/HenrikPuls/Drey.git
    branch: main
    path: E:/projects/Drey-m83
    instructions: docs/agents/fleet-worker.md
    link: [.tools, node_modules]
  lariscus:
    url: https://dev.azure.com/org/project/_git/lariscus
    branch: main
    policy: Azure DevOps branch policies protect main
---
Prose for humans.
```

`url` is any git remote (or a local path for a repo that only lives
on this machine); `branch` is the integration branch the ticket branch
forks from and merges into; `policy` is a free-text note recording
which protection exists (ADR-0075: hosts are interchangeable, the
fleet never calls a host API). `path` is the **local checkout /
worktree** where the repo's work is tested — the board's card context
menu opens a terminal there ("Open work folder in terminal": run
`.\dev.ps1`, the repo's build, whatever it uses). `worker` (M84) is the repo's default fleet worker for tickets on this
repo. `worktrees` (T-0044, ADR-0080) overrides where the fleet's
worktrees for this repo live — an absolute folder, or one relative to
the tickets repo root; the worktree is `<base>/<ticket-id>`. Unset (the
default) is `<ticketsRepo>/_worktrees`. `launch` (req-75 W3,
T-0057) is the command that starts the repository's program in a
ticket's worktree — "Launch this version" runs it there in a new
console; a non-string value warns and reads as unset. Unset means the
default `powershell -NoProfile -ExecutionPolicy Bypass -File dev.ps1
-Built -Multi` when the worktree has a `dev.ps1`, else no launch (the
button refuses with a hint at this file). `instructions` (req-79)
names the file, relative to the checkout at `path`, that every fleet
run's brief opens with verbatim (the context pack, ADR-0081) — a short
brief for unattended runs, since every model call of the run carries
it. Unset, or a configured file that is missing or blank, falls back
to `CLAUDE.md`, then `AGENTS.md`; an absolute path, one leaving the
repo or a non-string value warns and reads as unset. `link` (req-56) names
git-ignored folders of the checkout at `path` — one name or a list,
relative, never leaving the repo — that the runner links into every
fleet worktree (a junction on Windows, a directory symlink elsewhere)
instead of the worker rebuilding them: the toolchain (`.tools`,
`node_modules`). A folder is linked only when the checkout has it, the
worktree does not, and git ignores it there; the brief then tells the
worker not to install anything. Names are unique; a ticket's `repo:`
must name one of them once it is in a work phase.

The registry is edited in Settings → Tickets, Repositories (req-72):
the entries as editable rows, one commit per save, the prose under the
frontmatter kept — and "Add from folder…", which probes a picked
folder (itself plus its non-hidden subfolders) for git repositories
and registers the found checkouts as ordinary entries (origin URL,
current branch, absolute `path`). The file stays the single source of
truth; the scan is a seeding step, not a live reference. A ticket may
name several of these repos in its `repos:` list (see the frontmatter
fields) — the fleet prepares one worktree per name.

## `_meta/chat/` — the Mission Control sessions

One Mission Control chat session = one Markdown file under
`tickets/_meta/chat/` (E5a, ADR-0088 later change). A session is a vault
file like a ticket — indexed, watched and openable in Drey's editor; the
transcript the owner reads in the chat is the file itself. The filename
minted at start is `<stamp>-<slug>.md` (`20261102-090100-costs-export.md`):
the UTC stamp keeps names unique, the slug — the title lowercased to
`[a-z0-9-]`, cut on a word boundary, `chat` when empty — keeps them
readable. The frontmatter is two keys, plus a third on a shape session:

```markdown
---
title: "Costs export"
created: '2026-11-02T09:00:00Z'
---
```

`ticket: T-0130` (optional, E10-2) marks a **shape session**: the chat
shares that ticket's `## Plan` with the model. The engine keeps a shadow
copy of the plan per ticket (machine-local, `<engine home>/plan-shadow.json`
— never in the repository): the plan at the end of the model's last turn,
a turn counter (the "v7") and the lines the model itself changed in that
turn. A message sent in a shape session carries only the change shadow →
current (the owner's edits) to the model, as a summary and a diff; the
model's own edits are never mirrored back. The first turn has no shadow
and sends no delta (the model reads the plan itself). The owner can leave
the edits out for one message (`planEdits: false`): they are then
acknowledged but never sent.

The body is the transcript, one strict line shape per event. The writer
is strict (exactly these shapes), the reader tolerant (an unreadable
line is skipped, never guessed — the asymmetric-tolerance rule):

````markdown
- '2026-11-02T09:01:00Z' owner — Move T-0086 to review
- '2026-11-02T09:01:12Z' thought — The owner wants T-0086 moved …
- '2026-11-02T09:01:44Z' mission — Done. T-0086 sits in review now.
- '2026-11-02T09:01:44Z' proposal p-1 pending — Move T-0086 from build to review
  ```json
  {"kind":"transition","id":"T-0086","from":"build","to":"review"}
  ```
- '2026-11-02T09:02:10Z' proposal p-1 confirmed — Move T-0086 from build to review → ok
````

- `- '<UTC>' owner — <text>` — the owner's message.
- `- '<UTC>' thought — <text>` — the mission's thinking trace, the line
  directly before its `mission` line; folded away in the UI once the
  turn completes.
- `- '<UTC>' mission — <text>` — the mission's spoken reply.
- `- '<UTC>' plan-edit — <summary>` followed by the diff the model read
  in an indented fenced block marked `diff` — the **"You edited the
  plan" card** (E10-2), written directly before the owner line it
  belongs to. `<summary>` reads `2 edits · +3 −1`; the diff has an
  `@@ line <n>` header per group and `- old` / `+ new` lines. Plan-edit
  cards are not part of the history handed to the model.
- `- '<UTC>' question — <text>` followed by an indented `json` block
  `{"options":[{"label":"…","recommended":true}]}` (2–4 choices) — Paul's
  **answer card** in a shape session (E10-3). It is answered by the
  owner's next `owner` line (the picked label or their own words); there
  is no decision line.
- `- '<UTC>' split — <reason>` followed by a `json` block `{"parts":3}` —
  Paul's **split proposal** (E10-3): the reason, and N counted from the
  plan's `### Parts` (one when there are none). The owner's tap adds
  `- '<UTC>' split-decision keep|split — <summary>` (`Keep as one
  ticket` / `Split into 3 tickets`); a decided proposal stays as history.
  `keep` also moves the ticket from its phase into the pipeline's `build`
  phase (the phase after its own when there is none) in the same step.
- `- '<UTC>' sources — a; b; c` — the repository files Paul read in a
  turn (E10-3), `;`-separated; the session's distinct sources are the
  "Context:" line of the screen.
- `- '<UTC>' proposal p-<n> pending — <summary>` followed by the command
  in an indented fenced block marked `json` — a **proposal card**:
  `<summary>` is the human sentence the card shows, the block is the
  typed `ChatCommand` (`createTicket` / `transition` / `setPriority` /
  `promote` / `setChain` — the union in
  `packages/tickets-engine/src/contracts/chat.ts`
  is the entire write surface). Ids mint per session (`p-1`, `p-2`, …).
- `- '<UTC>' proposal p-<n> confirmed|dismissed — <summary>` — the
  owner's decision. The summary repeats the pending card's; a
  ` → <outcome>` tail (the moved path, a refusal) rides when the
  execution reported one. Proposals are append-only history — a
  decision adds a line, never rewrites one.

**The one exception — the shared plan (E10-3).** In a shape session
Paul's turn may carry a new `## Plan` chapter, which the engine writes
into the ticket right away (`tickets: <id> plan`): only that chapter
changes (`core/plan-section.ts`; a `## ` line inside the text is demoted
to `###` so it cannot swallow the next chapter), and a live run on the
ticket refuses the write. The plan is the document the owner edits beside
the dialog; the next message carries only the owner's own edits back
(E10-2). Nothing else a shape turn does touches the board without a tap.

The grammar exists for the chat's iron rule (concept §6): **the chat
never writes on its own** (bar the plan chapter above). The session file is the only thing the chat
writes; a ticket mutation exists only as a proposal's command block and
runs on the owner's explicit confirm, through the same board methods
the invoke channel exposes — never a second write path. The file is the
audit trail: read top to bottom it shows every proposed and every
executed mutation.

Every session write is exactly **one git commit**, message
`tickets: chat <file>` — the owner turn (owner line, thought, mission
reply and its proposal lines) commits once; a confirm/dismiss decision
commits once. The reader (`packages/tickets-engine/src/core/chat-session.ts`)
forgives: a file without a readable frontmatter fence reads as absent,
a half-readable one yields what it can.

## Validation (where it runs, what it checks)

There is **no CI on the tickets repository** (owner's ruling,
ADR-0076). The one deterministic validator runs where the data is
read: the board on every render (issues are badges on the card and the
column; the board still renders), the fleet runner before every action
(refuses an erroneous ticket). Checks, all deterministic:

1. id grammar; id = filename stem; no id in two phases.
2. Required fields present (`id`, `title`, `priority`); enums valid;
   timestamps parse; `run` map shape.
3. `branch` matches `t/<id>` (rule wins; mismatch = badge).
4. Phase directory ∈ `pipeline.md` phases, compared on the
   prefix-stripped id (`50-build` and `build` both match `build`;
   tickets in an unknown folder render in a trailing "unknown" column —
   visible, not lost). `tickets/archive/` is excluded from the board
   entirely (never a column, never a badge).
5. `entered-<phase>` keys reference known phases (unknown keys =
   noise badge).
6. `claimed-by` grammar; `claimed-at` present with `claimed-by`.
7. `repo` (when present) resolves in `repos.md`.
8. (Removed with req-75 W1: `order.md` is no longer read.)
9. A ticket without backticked acceptance criteria cannot be worked:
   the fleet refuses to start an agent run for it (the most common
   dispatch hold — the gate would have nothing to run). The one exception
   is a run in the pipeline's first automatic column (req-93): its plan
   writes the criteria, so that run gates structurally and the gate
   checks that they came into existence.
10. `blocked-by` resolution (T-0050): ids resolve against the board's
    columns only — never `tickets/archive/` — and a satisfied reference
    is one sitting in the terminal phase **or no longer on the board**:
    an archived, deleted or renamed blocker does not block (owner
    decision 2026-10-31 — archiving a finished blocker stalled the
    chain; a mistyped id unblocks too, the accepted price). Self-reference and cycles are one
    **error** per member naming the cycle (`blocked-by cycle: T-0001 ->
    T-0002 -> T-0001`; self = `T-0001 -> T-0001`); the board still
    renders, and cyclic members count as blocked. A duplicate blocker
    id resolves to the first occurrence in column order (the duplicate
    itself is already an error per check 1).
10. `blocked-by` entries resolve against the board's columns (T-0050):
   an id off the board (archived, deleted) no longer blocks;
   self-reference and cycles = errors naming the cycle; a
   reference on the board is satisfied only in the terminal phase — a
   blocker in an unknown directory blocks. The archive is never consulted.
11. `form` (E8): when present, `ship` or `scout` — any other value
    warns (`form must be ship or scout — read as ship`); the key is
    preserved on rewrite like every unknown field.
12. `chain` (E9): each entry parses in the delta grammar (`insert …
    after|before …`, `skip …`, `notify …`, `move …`, `assign …`) — an unreadable entry
    warns and drops, never guessed; the semantic guard (unknown
    phases, past-gate references, skip/insert conflicts) runs where a
    write is decided, not on render (see
    [The chain delta](#the-chain-delta-e9-concept-57)).

A validation issue never blocks rendering and never blocks a human
transition (a warning shows); it blocks an agent action.

## Normalization (a file move is a ticket move, T-0041)

On every board fetch the plugin runs a **stateless drift pass** over
the ticket files (derived from the files alone — it survives restarts
and re-runs safely because the treatment is idempotent):

- For a ticket with parseable frontmatter and no live `run:` map, in
  known phase B: treatment ⟺ `entered-<B>` is missing or older than
  the newest of (all `entered-*` stamps, the archived marker). The
  treatment stamps `entered-<B>`, appends the Log line
  `<from> -> <B>` (`from` = the holder of the newest event;
  `archive` when the archived marker dominates; `unknown` when no
  stamp exists at all) and commits exactly once, `tickets: <id> <from> -> <to>`, actor
  `owner@<host>`.
- In `tickets/archive/`: treatment ⟺ no `— archived` Log marker newer
  than every `entered-*` stamp; the treatment appends the marker and
  commits `tickets: <id> archived` (no `entered-` stamp).
- Skipped: files with parse errors or error-level findings, tickets
  with a live `run:` map (the runner owns the file mid-move), unknown
  directories, `_meta`. Backwards moves and skips are logged, never
  blocked — lane rules stay runner-only.

## Reading tickets from a dricket store (E14-2, read-only)

With `tickets.backend` set to `dricket` (or `shadow`, which only compares) the
board's tickets come from a dricket store (`docs/design/dricket/`) instead of
`tickets/<phase>/*.md`. `pipeline.md`, `repos.md` and the ledger still come
from the tickets vault. A store ticket is folded into the layout above by
`packages/tickets-engine/src/store/store-board.ts`; the card's `path` stays
the virtual `tickets/<phase>/<id>.md` (there is no such file).

| dricket | Ticket key here | Note |
|---|---|---|
| `stage` | the phase directory | `x-phase` if it names a phase, else the stage itself when it is a pipeline phase id (store configured with `[stages]` = the phase ids), else the built-in names by role: `open`/`blocked` → first column, `in-progress` → first `claim: true` column, `review` → `commit`, `done`/`cancelled` → last column; anything else is an unknown column with a warning |
| `id`, `title`, `priority`, `parent`, `repos` | same | the store's `[priorities]` must use the pipeline's words |
| `depends` | `blocked-by` | `blocked`/`blocks` stay derived |
| `owner`, `claimed_at` | `claimed-by`, `claimed-at` | |
| `x-rank` | `rank` | |
| `x-worker` `x-persona` `x-track` `x-form` `x-proof` `x-awaiting` | `worker` `persona` `track` `form` `proof` `awaiting` | raw values |
| `x-interactive` | `interactive` | only `true` |
| `x-chain` | `chain` | entries separated by `;` |
| `x-references` | `references` | separated by `,` |
| `x-entered-<phase>` | `entered-<phase>` | |

Not carried: `branch` (the rule `t/<id>` wins), `run` (the runner's table),
`parked-*` (a parked ticket is stage `blocked`), `labels`, `kind`, `size`,
`epoch`, `rev`, lease times. The archive is not a column in either backend.

