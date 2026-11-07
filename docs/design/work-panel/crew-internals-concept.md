# Crew internals — the concept note of the design session of 2026-11-07/08

Status: **rulings recorded, nothing built.** Design session with the owner on
req-152 (the Crew's 1:1 and the personas' inner workings) and req-153 (the
Persona page), as the roadmap asked: *"to be discussed in a session of its own
with the owner (Claude Design first), nothing built before."* This note is the
outcome; the ADR drafts it names are `docs/09_architecture_decisions/0092`–`0095`
(status proposed). The mockups live beside it in `crew-internals/`:

| File | What | Artifact (owner's view) |
|---|---|---|
| `crew-internals/service-mockup.html` | Drey Service: the tray window (components, sessions), the tray menu, Settings → Background service | https://claude.ai/artifact/ACmhjswe4Ztd1c9xtq9iTW |
| `crew-internals/pool-flow.html` | Owner → Pia → pool → session: the sequence and the three ledgers | https://claude.ai/artifact/9Y81fS9FLinrcffv9n3B86 |
| `crew-internals/persona-page-mockup.html` | The Persona page after the rulings (req-153) | https://claude.ai/artifact/QqY8Jxm2zkP1G8reJL5Te2 |

The owner's words are quoted in German where they carry the ruling. Everything
else is English, like all documentation.

## 0. What exists today (the findings the rulings rest on)

- **The 1:1 tab** appends the owner's line to `tickets/_meta/personas/<id>/thread.md`
  (`personaThreadAppend`); the context pack hands the thread to the persona's
  *next run* as a "Coaching" section. No model answers. That is D-52.
- **Shape with Paul and Mission Control** are not runner sessions: the engine's
  **chat bridge** makes a direct HTTP call with the Drey assistant's LLM settings
  (`chat.*`, D-1); Paul gets up to three read rounds the engine performs for him.
  CLI providers (Claude Code, Kimi) have no endpoint the bridge can speak.
- **Memory** (`memory.md`) is written only from the owner's side: the memory
  dialog, "teach" in the chat, and an accepted Friction proposal. The persona
  writes nothing at the end of a run, although concept §4.4 planned it. Friction
  lines aggregate (3 findings, or 3 plus 5 settled runs) into `improvements.md`,
  shown as the Friction card on 7k.
- **Skills** (`persona.skills`) resolve nearest first, `personas/<id>/skills/`
  then `_meta/skills/`, as `<name>.md` or `<name>/SKILL.md`, and ride as
  `## Skills` behind the prompt in the brief (D-46, milestone 204).
- **Vault over MCP:** ADR-0075 promises it ("vault access for a worker goes
  through Drey's governed MCP server"); nothing wires it. No worker is given an
  MCP server today. Drey's own MCP server lives in the Drey process (stdio
  bridge, opt-in HTTP on 127.0.0.1, write rule `mcp.yolo`) and dies with Drey.
- **Processes:** the tickets engine is its own process (`~/.drey-engine`,
  lockfile, spawned by the plugin, never stopped by Drey, serves the phones with
  Drey closed, reads and writes the vault directly for the Notes API with
  ADR-0060's conflict guard but without save hooks or the local history); the
  fleet runner is a second detached process (`<userData>/fleet`, req-110 idle
  exit). Both are invisible: no window, no tray, logs in files only.
- **Pool:** parallel slots belong to the worker providers
  (`fleet.pool.<provider>.size`, req-63); a persona has an ordered model pool
  with a router policy; req-112 (the model budget) is undecided.

## 1. Rulings

Numbered, dated, in the order they were made. "Recommended" marks the option
the session proposed; the ruling is the owner's.

### R1 — A 1:1 is a runner session of the persona (2026-11-07)

**Ruling:** the 1:1 is a **session of the persona's own harness and model**
(worker and model from its pool), started quiet with no ticket and no worktree,
**requested from the pool like any other task**, with a **lean 1:1 toolset**
(read the board and tickets, later the vault over MCP — never the build set).
A persona with `worker: api` talks over the chat bridge, as the worker key
already decides.

The owner weighed it himself before ruling: *"ohne persona ist es doof aber ob
man dafür jetzt das tooling des agenten braucht? auf der anderen seite könnte
er aufgrund des kontextes besser 'verstehen', gleichsam ist das abhängig vom
verwendeten modell."* What decided it: a persona on a CLI worker has no HTTP
endpoint, so over the bridge the *assistant's* model would answer, not Ben; and
his second wish — *"dass wir dem modell nicht alles geben, ihm aber den zugriff
geben"* — is a tool call, which the bridge cannot make. The model dependency is
a property of the persona's pool, not of the 1:1. An idle session costs no
tokens, only a held slot until req-157's release.

Deviation recorded: concept §4.7 planned the persona chat as a direct call.
This ruling supersedes that row of the table.

### R2 — Context of a 1:1 (2026-11-07)

**Ruling:** profile + memory + the last runs — `persona.md`, `prompt.md`, the
skills, `memory.md`, the conversation so far, and a short list of the persona's
latest runs (ticket, outcome, cost, gate failure). The board is **not embedded**
as a digest; the owner: *"das aktuelle board wäre manchmal auch ganz
interessant, aber kriegen wir den zugriff über mcp oder so hin"* — so the board
and the tickets are reached through tools (R1's lean set).

### R3 — Where a 1:1 lives (2026-11-07)

**Ruling:** as a **chat session file under `tickets/_meta/chat/`** with a
`persona:` key, in the format of the Mission Control sessions (one commit per
round, proposal cards with accept/dismiss). `thread.md` is retired; its lines
migrate once into the persona's first 1:1 session. Nothing a 1:1 says reaches
the next run unasked any more — only what lands in memory (R4) or in an accepted
proposal.

### R4 — Memory: direct entries by model and owner, each removable (2026-11-07), details OPEN

**Ruling (the owner's words):** *"das modell soll einträge ins memory einfügen
können, ebenso der nutzer direkt … beides soll der nutzer aber auch einzeln
entfernen können. nicht jeder run muss etwas ins memory eintragen nur wenn es
besonderheiten gab, fehler die aufgetaucht sind, wo korrigiert werden musste, so
dass man daraus ableiten kann ob ggf. ein anderes modell oder ein besseres
prompting besser funktionieren würden."*

So: the persona writes `memory.md` **directly** (no proposal gate for memory
lines), the owner too; every line carries its author and evidence and is
removable one by one; a run writes only when something was out of the ordinary.
The "nothing is adopted automatically before a 1:1" rule of req-152 **stays for
prompt, skills and model** — those remain proposal cards (R11).

**Deferred — the owner asked to think it through once more** (*"lass uns das
mit dem memory gleich noch mal diskutieren welches vorgehen da wirklich
sinnvoll ist"*, then "noch nicht entschieden"). The two variants on the table:

- **A — journal + lesson (the session's recommendation).** Two things hide in
  one word. The *finding* ("where did it stumble, model or prompt?") is per-run
  evidence that belongs with the run telemetry, not in the next run's context —
  a model that reads criticism of itself as instruction does not improve, and
  only there can it be grouped by model ("sonnet stumbles on tests for Ben three
  times, qwen never"). The *lesson* ("next time do it this way") is memory, one
  line the next run reads, where quality matters because a wrong lesson poisons
  every following run. Mechanics: a closing round of the session **after the
  gate verdict**, **only when the run was noteworthy** (red gate, retry, an
  owner steer, cost far above the typical run, or self-reported friction) — a
  smooth run costs no round (§4.9's principle: a model wakes on a real event).
  The finding goes to `reviews.md` in the persona folder (one entry per run,
  with model and ticket) and into `GET /report`; the lesson, at most one line,
  goes straight into `memory.md` as `- <date> · <ticket> · <persona>/<model> ·
  <lesson>`, the owner's lines as `· you ·`. Memory tab: both lists, delete per
  line, pin as today; the context pack takes pinned first, the rest capped.
  Friction stays the source of prompt/skill/model proposals only.
- **B — one file.** Finding and lesson as lines in `memory.md`; the next run
  reads both; the evaluation by hand.

Open until the owner rules: A or B; the exact trigger list of "noteworthy";
the line format; whether the journal shows on the Crew tab or only in the
report.

### R5 — Vault rights of a run: read all, write none by default (2026-11-07)

**Ruling:** without an entry in the persona record a run **reads every
registered vault and writes none**. Writing is granted per vault in
`persona.md` (`allowed:`, req-142) and needs no dialog — a detached run cannot
wait for a click. `vault_delete` is never offered to a worker. The tickets
repository is reached by no vault tool (the working copy and the ticket tools
of D-30 do that).

### R6 — One shipped background process: Drey Service (2026-11-07/08)

**Ruling (the owner's words):** *"die engine selbst soll ein plugin prozess
werden, welcher bereits mit drey ausgeliefert wird und auch den mcp
bereitstellt. in diesen sollen sich andere komponenten wie der crew service
einklinken können. der service soll außerdem eine eigene Oberfläche bekommen
mit der möglichkeit sich anzusehen welche es gibt sowie die log nachrichten und
die möglichkeit sie zu stoppen oder einen zu starten. unsichtbare
hintergrundprozesse sind nicht gut. und ein taskleisten symbol wäre dafür gut
(rechts bei windows), dass ich darüber das ui öffnen kann und es sonst im
hintergrund bleibt."*

Name, ruled 2026-11-08: **Drey Service** (over Drey Hub, Drey Daemon). Its
components: **Tickets engine, Crew runner, MCP server, Remote gateway** (and the
local model's reachability as a read-only row). It replaces the two invisible
processes and Drey's in-process MCP server; Drey becomes a client of it. The
design (window with the component list, state dot, restart/stop and the
filtered log; the tray icon with its menu; Settings → Background service with
autostart, idle span, tray on/off, component switches, log level and folder)
is the service mockup. The owner added: *"könnte man hier auch die session mit
dem harness kontrollieren? wäre fürs debugging sehr hilfreich"* — ruled in as
the **Sessions** area: every harness session (run or 1:1) raw — process, session
ref, tokens, MCP calls; tabs Stream / Instruction / Tool calls / Process; a
send line into the session's stdin (ADR-0075's steer, logged to the ticket),
interrupt, resume after stop, open worktree, copy the attach command
(`claude --resume <ref>`). Drey's Thread stays the clean view; the service is
the workshop. The owner: *"nachdem das design abgenommen wurde, kannst du das ui
bauen"* — the build is a roadmap item (§3), not this session.

ADR draft: **0092**.

### R7 — The engine (Drey Service) serves the vault MCP (2026-11-08)

Follows from R6: the MCP endpoint workers and 1:1 sessions use is served by
Drey Service, not by the Drey process, so a run never depends on Drey being
open — like the runner and the phones. Same tool names and semantics as
ADR-0071 (`vault_list`, `vault_search`, `vault_read`, `vault_edit`,
`vault_write`, `vault_move`; no `vault_delete` for workers); the logic behind
them is the shared code in `shared/` (text edit, note search, frontmatter), the
path the Notes API already walks. Price, stated: a write does not go through an
open Drey tab or the local history; ADR-0060's mtime guard protects, Drey's
vault round reloads clean tabs. **Authentication:** a per-run token the
service mints at spawn and hands the worker in its MCP configuration
(claude-code `--mcp-config`, opencode its config file in the worktree, Kimi by
capability; a harness without MCP gets no vault and the log says so);
token → run → persona → permissions (R5); every call is logged to the run's
stream (the audit of ADR-0075); the token ends with the run. The device tokens
of milestone 204 stay the phones'. ADR draft: **0094** (an ADR-0071 later
change).

### R8 — Skills: shared pool, Agent Skills format, inline (2026-11-08)

**Ruling:** skills stay files; `_meta/skills/<name>/SKILL.md` is the shared
home, `personas/<id>/skills/` overrides a same-named skill (D-46's order
already); the file format is the **Agent Skills** format so the owner's existing
Claude skills drop in unchanged; run and 1:1 load them through the same
instruction composer as `## Skills` behind the prompt, **in full**. Progressive
loading (name and description in the prompt, body by a `skill_read` tool) is a
later item once a persona carries many skills. req-137 (listing, upload) and
req-143 (token count, full-prompt preview) stand.

### R9 — Pia executes, she does not work; every piece of work is a session (2026-11-08)

Mission Control stays a direct call with intents and proposal cards; Pia is the
owner's interface and the pool's controller. Every unit of work — a ticket run,
a 1:1, later also Shape with Paul — is a **session** with its own record and
its own costs. The flow is the pool-flow mockup.

### R10 — The pool: a model table with classes, a capacity cap, no downgrade (2026-11-08)

**Ruling (the owner's words):** *"jedem modell sollte man eine kategorie
zuordnen können und eine capability-klasse, und ein kostenfaktor. in den
settings soll definiert werden, wie hoch der gleichzeitige verbrauch sein darf.
wenn gerade nicht genügend kapazität vorhanden ist, dann soll abgelehnt werden
und nicht einfach eine kleinere stufe verwendet werden. nur die aktiven
sessions werden gezählt, dann wartet er auf den slot."*

So req-112 becomes:

- **Settings → Models**, a table: model id, provider, **category**,
  **capability class**, **cost factor**, and per provider how many concurrent
  sessions it serves (the slots of req-63 move here). A persona's pool is built
  from this table only.
- **A capacity cap** in Settings: the sum of the cost factors of the **active
  sessions** may not exceed it (per provider, and a global one).
- **A session requests a class.** It gets a model of **exactly that class**
  from the persona's pool with capacity left, or it **waits for the slot** — no
  process is spawned, the card says "queued · waits for a <class> slot", Pia
  can explain it, the dispatcher takes the next task whose class is free.
  **Never a smaller class.** (This replaces the session's "smallest sufficient
  tier" proposal.)
- **Three ledgers**, one figure each: ticket allowance (req-113), persona per
  day, provider per day. A full ledger grants no slot and raises a Needs-you
  card. Counting happens only on the session record (run telemetry); every
  other figure is a sum.
- **Assumed, not ruled** (the owner did not object, did not confirm): who asks
  for which class — Paul gives each plan part a size (S/M/L) that maps to a
  class; a phase has a floor (plan and review not below class B); a ticket pin
  overrides; the owner can change it on the card.

ADR draft: **0095**.

### R11 — The Persona page (req-153) (2026-11-08)

**Ruling:** the mockup stands, with one correction from the owner: *"ich möchte
dort nicht open as markdown, sondern der markdown editor soll direkt in
instructions sichtbar sein."* So: **no "Open as Markdown" button**; the
Instructions block **is** Drey's Markdown editor (the CodeMirror surface, Live
Preview ⇄ Source, the formatting strip) over `prompt.md`, with the token count
and "Preview full prompt" (req-143). Further blocks: Profile (picture, name,
role, the one line for the crew list — req-144); Work (steps as read chips from
the flows, harness, the ordered models from the model table with class, factor
and busy slots, daily budget, Tell me when); **Allowed to** (req-142: read
vaults, write vaults per vault, run commands = permission mode, reach the
network, spend above the allowance); **Skills** with a switch per skill, shared
or own, token count, Add skill…; **Proposals** (the Friction card renamed; from
Friction and the 1:1; Show diff / Dismiss / Apply). Memory, Journal and the 1:1
stay tabs of the Crew detail; the page links to them and its head counts them.
Footer: Discard, Save — one commit to `personas/<id>/`.

**One prose, not two (ruled "Ja"):** `persona.md` keeps the frontmatter plus
the one-liner (`summary:`); the "who Ben is" prose lives at the top of
`prompt.md` — the prompt *is* the persona. The placeholder sentence ("Who
build-default is: role, tone, limits. Edit freely — the next run reads it.")
disappears; existing `persona.md` prose migrates once into `prompt.md`.

## 2. Open questions the owner deferred

1. **Memory A or B** (R4) and its details: trigger list for "noteworthy", line
   format, where the journal shows.
2. **Who requests which class** (R10, assumed: Paul's part size, phase floor,
   ticket pin).
3. **Shape with Paul as a session** (R9 says "later also"): keep the bridge
   with its read rounds until the 1:1 session exists, then decide from the
   numbers (req-109).
4. **Settings → Models** needs its own design pass (table columns, the cap, the
   per-provider slots) before the build; it was described, not drawn.
5. **The 1:1 toolset's exact list** (R1: board, tickets, vault read) — fix it
   when the MCP server of R7 exists.

## 3. Roadmap items to add or reword (ids proposed; the integrator assigns)

Items leave the roadmap only when they ship; these are the proposals in build
order. "req-16x" are placeholders after req-160, the highest id on 2026-11-08.

| Proposed id | Title | Replaces / touches |
|---|---|---|
| **req-161** | Drey Service: the shipped background process (engine, Crew runner, MCP server, remote gateway as components; lockfile, start with Windows, idle span, Drey as its client) — ADR-0092 | absorbs req-110's lifecycle, D-51's runner spawn, part of req-154 |
| **req-162** | Drey Service UI: the tray icon and menu, the window (Components, Logs) — build after the design is accepted (the owner: "nachdem das design abgenommen wurde, kannst du das ui bauen") | new Settings category Background service |
| **req-163** | Drey Service Sessions area: every harness session raw, Stream / Instruction / Tool calls / Process, send to stdin, interrupt, resume, attach command | ADR-0075 steer ladder at raw level |
| **req-164** | The vault MCP served by Drey Service: ADR-0071 toolset over `shared/`, per-run tokens, persona permissions (R5), call log in the run stream, harness MCP configuration per adapter — ADR-0094 | ADR-0071 later change; req-142 gets its enforcement |
| **req-165** | The 1:1 as a persona session: quiet start without ticket, lean toolset, context of R2, chat session file with `persona:` (R3), `thread.md` migrated, the Crew tab's 1:1 tab talks to it; release after idle (req-157) — ADR-0093 | **resolves D-52**; reshapes E13-19's "Talk to <name> 1:1" |
| **req-166** | Persona memory per R4: author and evidence per line, delete per line on the Memory tab, the persona's own entries at run end (variant A or B once ruled) | reshapes the Friction flow (memory lines leave it) |
| **req-167** | Settings → Models and the capacity pool: the model table (category, class, cost factor, provider slots), the cap, class requests, queue without a process, three ledgers — ADR-0095 | **replaces req-112**; absorbs req-113's allowance, req-63's `fleet.pool.<provider>.size` |
| **req-168** | Persona page v2 per R11 (req-153 done when this ships): the Markdown editor in Instructions, Allowed to, models from the table, Skills with switches, Proposals, one prose | **replaces the page part of req-153**; closes req-142/143/144/137's page halves; E13-19 loses the page items |
| **req-169** | Skills as Agent Skills: `_meta/skills/<name>/SKILL.md`, listing and upload (req-137), token count (req-143); progressive loading as a later item | reword req-137 |
| reword **req-152** | now "designed — see `docs/design/work-panel/crew-internals-concept.md`"; leaves the roadmap when req-161–169 are on it | |
| reword **req-153** | same; the mockup is `crew-internals/persona-page-mockup.html` | |
| reword **req-157** | the session lifecycle now applies to runs *and* 1:1 sessions held by the Crew runner | |
| **decisions.md** | the persona chat as a direct call (concept §4.7 row) — superseded by R1; "smallest sufficient model" (req-112's wording) — rejected by R10, no downgrade | |

## 4. What this session did not do

No code under `plugins/`, `packages/` or `libs/` changed. The roadmap,
changelog and `decisions.md` are not edited here (the integrator does that from
§3). The Settings → Models page is described, not drawn. The memory ruling is
open (R4).
