# 58. The assistant as the task & navigation surface — task provider + `api.links`

## Status

Accepted (milestone 57). Builds on ADR-0044 (registry-over-SDK rule),
ADR-0047 (the tool loop the `tasks_list` tool rides), ADR-0048 (the chat
note the task block renders from) and ADR-0046 (the wikilink resolution
the new links surface fronts).

## Context

Beta use showed the convergence the owner wants: one text surface — the
assistant — through which everything can be asked and reached, with the
Search/Tasks panels as the no-LLM fallback, not parallel primary
interfaces. Two concrete gaps stood in the way:

- Asking "which tasks are open?" got a plain-text answer quoting task
  lines from retrieved context — no links, no due badges, nothing
  actionable, and the model could misquote.
- `[[wikilinks]]` in answers rendered as dead text: the panel had no
  Markdown at all (`textContent`), let alone navigation.

Both must be real data: the model never fabricates task rows (the same
discipline as ADR-0049's "raw data over a broken widget"), and link
targets resolve against the base's live note index.

## Decision

**1 · Task-index seam (SDK minor 1.11).** A single-slot registry mirroring
the section-search pattern: `ctx.tasks.registerTaskQuery(provider)` on the
main context, `queryProvider()` for consumers. The `TaskQueryProvider`
contract (`query(opts)`, `setDone(task, done)`) lives in the SDK; the
tasks plugin remains the sole grammar owner — line resolution and the
toggle are its `resolveTaskLine`/`setDoneOnLine`, a consumer never edits
task lines itself. The tasks plugin registers its per-vault index; the
record shape crosses the SDK as a structural contract (`SdkTaskRecord`).

**2 · The `tasks_list` tool.** The assistant attaches its own spec to
every non-live ask (deliberately **not** gated on `mcp.enabled` — a task
question must not depend on an unrelated switch; the doc tools set the
no-MCP precedent). The handler emits one JSON object per line — the same
shape MCP's `tasks_list` returns — capped at 150 rows with a truncation
note. The system prompt says to prefer the tool over quoting task lines
from retrieved context. Tool call + result persist in the turn's
`drey-tool` fence and replay as real messages (ADR-0048 machinery, no new
persistence).

**3 · The interactive task block.** The panel renders a `tasks_list`
call/result pair as a task list instead of raw chips (unparseable results
fall back to the chips). Rows carry checkbox, text, priority glyph, due
badge (overdue/today colored — the Tasks panel's language); a row click
opens the note at the line (`documents.open(path, line, {vaultId})`). The
fence rows are a snapshot: the live `done`/`due` state hydrates from the
provider at render time (ADR-0055's fresh-hydration rule), so a completed
task shows completed in every older answer too. The checkbox goes through
the provider's `setDone` (assistant main IPC hop), writes announced, and
re-hydrates the block.

**4 · `api.links` (renderer SDK).** Base-owned grammar + navigation, so
plugins never carry a third copy of the wikilink machinery:
`parseInline(text)` (pure segmentation over the editor's
`extractWikilinks`), `resolve(target)` (sync render probe over the merged
index, active-vault default) and `open(target, anchor?)` — the full
editor flow: open the resolved note at its `#heading` anchor line, or
CREATE the missing note. Same-file `[[#anchor]]` stays plain text (a chat
has no "linking note" to resolve against).

**5 · Rich card bodies.** The panel's turn text (question, answer,
streaming partial) renders through a deliberately small Markdown subset —
paragraphs, `-`/`*` bullets, `1.` lists, `**bold**`, `*italic*`,
`` `code` `` — composed with the wikilink segments. DOM nodes only, never
`innerHTML`: model output is untrusted text. Links style by the resolve
probe (resolved accent / unresolved muted-dotted, the editor's look).

**6 · The model may write wikilinks.** The ask system prompt says to
reference vault notes as `[[path]]` / `[[path#heading]]` using exactly
the paths from context. This is a conscious deviation from milestone 49's
"the model never mints links" rule — that rule stands unchanged for the
DETERMINISTIC Sources digest (a summary must cite only real sections);
answer prose is navigation aid where an unresolved link degrades
visibly and a click resolves it for real. Known side effect, accepted:
`insert into note` copies raw answer text, so a model-written link lands
in a real note where Ctrl-click creates the target — the user steers with
the prompt hint.

**7 · MCP symmetry.** `tasks_list` joins the vault tool set (read-only;
completing tasks is not an MCP operation v1), degrading with a clear
error when no provider is registered — same contract as `vault_search`.

## Later change — the answer-anchored task block (57b)

The first live test showed the model's tool call is not dependable: the
same 9B local model called `tasks_list` in one run and, in the next,
summarized task lines straight from the Vault-chip retrieval (correctly,
but with no block). Prompt shaping cannot close that gap — and keyword
detection on the QUESTION was rejected: keywords break the moment the
vault language changes.

So the trigger moved to the ANSWER, where no language assumption is
needed: after a non-live ask, the engine matches the answer text against
the live task index (normalized word overlap — a task matches when ≥ 0.4
of its ≥ 4-character tokens, at least 4 of them, appear in the answer;
models quote task titles verbatim, which is what the matcher anchors
to). One matched task means the answer is task-shaped, and the engine
persists a synthetic `tasks_list` call/result pair carrying the FULL
open set (`arguments: {"posthoc":true}`) after any real tool-trace
entries. Consequences:

- The interactive block appears whenever an answer is about tasks —
  model tool calls stay welcome (and suppress the synthetic pair), but
  are no longer load-bearing. False triggers (an answer that paraphrases
  task words without being about tasks) render real index data — mildly
  noisy, never wrong data.
- Follow-ups replay the synthetic pair as the model's own tool result,
  so the conversation keeps the task context.
- Known limit, documented: a fully translated PARAPHRASE with zero
  shared words stays under the threshold; models quote titles verbatim
  in practice.

## Later change — deterministic task views (57c, SDK 1.12)

The first live runs with the block confirmed the architectural reading:
the model is a poor LIST BUILDER (it answered in index order — no
importance) but a fine INTENT READER. So the view moved entirely to the
data owner, and the model's role shrank to intent + framing prose:

- **The provider sorts and filters.** `TaskQueryOptions` gains
  `sort` (`file` | `due` | `priority` | `importance`), `text`, `tag` and
  `overdue`; the tasks plugin implements them over the same shared
  comparators/matchers its panel uses (`plugins/tasks/shared/tasks.ts`,
  57c) — one semantics for the Tasks panel, the assistant block and MCP.
  `importance` (the assistant's default) is due-ascending first (overdue
  naturally leads), priority within the undated rest, path/line last.
- **The model's intent channel is the tool arguments.** `tasks_list`
  accepts `text`/`tag`/`overdue`/`sort`; the ask prompt tells the model
  to express the question's restriction there. A model call produces a
  filtered, deterministically ordered fence — the panel renders it with
  the filter as head chips and a real empty state (`No tasks found.`
  renders as an empty block, not a chip fallback).
- **The post-hoc block stays the unfiltered safety net**: all open
  tasks, importance-sorted — correct even when the model never calls.
- MCP `tasks_list` takes the same arguments (pass-through); without a
  `sort` it keeps the provider's file-order default so an external
  client's view is never silently re-ordered.

**Live feedback (57c addendum) — the block is answer-scoped.** The first
runs with the intent args showed the 9B model calling `tasks_list` with
`{}` on a restricted question ("wichtigste Tasks von Henrik"), so the
block listed everything. Two counters, prompt first and guarantee
second: the ask prompt and tool description now carry explicit few-shot
examples (person/topic → `{"text":…}`, `#tag` → `{"tag":…}`,
"overdue" → `{"overdue":true}`, whole set → `{}`) — small models need
them. And deterministically, the engine now scopes the persisted result
to the ANSWER in both failure modes: the post-hoc pair carries the
MATCHED subset (not the full open set), and an unrestricted model call's
result is trimmed to the answer's strict subset (`refineTasksEntries`;
a restricted call, a whole-set answer and a zero-match answer are left
untouched). The replay shows the trimmed result, so follow-ups stay
consistent with what the block shows.

## Later change — done tasks, the date, and the edit guard (57d, SDK 1.13)

A beta chat failed three ways in a row; each had its own cause.

- **"Which tasks were completed recently" had no view.** `includeDone`
  only WIDENS (open + done, importance-sorted), and no completion date
  existed. `TaskQueryOptions` gains `status` (`open` | `done` | `all`,
  wins over `includeDone`), `completedSince` and the `completed` sort;
  the date itself is ADR-0033's 57d change. `tasks_list` (assistant and
  MCP) takes the same arguments; `status: "done"` defaults to the
  `completed` order and `completedSince` implies it. A done-only call
  counts as a scope restriction, so `refineTasksEntries` never trims it.
- **The model described its arguments instead of using them.** The
  done-task prompt row was the only one without a few-shot example; it
  has two now, plus "call again instead of telling the user what you
  would query" and "never mention the tool or its arguments". The system
  prompt carries **today's date** (without it "recently" cannot become a
  `completedSince`), and the retrieved vault context now sits BEFORE the
  task note — "answer tasks only from the tool" is the later instruction
  and overrides the task lines that context carries.
- **"ja dann mach das" became a change proposal** for the focused daily
  note. Prompt first, guarantee second, as in 57c: `ASK_SYSTEM` restricts
  the Change form to an explicit request to modify the document and
  names the confirmation/follow-up case; and the engine's **edit guard**
  only accepts a `document` fence as a proposal when it changes the
  document AND the model did not call `tasks_list` in that turn —
  otherwise the prose outside the fence is the answer.
  Known cost: "write my open tasks into this note" as a plain ask is
  answered with the task block instead of a proposal; Live edit is the
  route for that.
- **Short tasks never got a block.** `matchTasksInAnswer` demanded four
  shared significant words, so a three-word task could not match. A task
  with fewer words now matches when ALL of them appear (from two words
  up). The post-hoc block also falls back to completed tasks when no
  open task matches the answer.

## Consequences

- Task questions get actionable answers: rows are index data, clicks
  navigate, checkboxes persist. The model can no longer misquote a task
  line it only saw in a retrieval snippet.
- The tool rides every non-live ask on tool-capable providers — a small
  spec, no token cost unless the model calls it. `maxToolRounds: 3` on
  plain asks keeps a loop-happy model bounded.
- Answers read properly (bold/lists) and navigate; the third
  wikilink-grammar copy that would otherwise have landed in the assistant
  plugin does not exist.
- A task index is now a cross-plugin contract: a future Task Center or
  alternative task source plugs in by registering a provider.
- Convergence staging (the owner's direction, not built here): Stage 2 —
  a local intent router answering simple `#tag`/search intents without
  the LLM; Stage 3 — ephemeral quick-asks that skip the chat-note log.
  The Search/Tasks panels remain the no-LLM fallback throughout.
- Plugin API: minor 1.11 (additive; major gate unchanged).
