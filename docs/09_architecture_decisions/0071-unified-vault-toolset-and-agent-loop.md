# 0071 — One tool loop, one vault toolset, one system prompt for the assistant

## Status

Accepted (2026-10-13), built in three steps: the tool loop and the system
prompt (milestone 76, **done**), the vault toolset (milestone 77,
planned), the open note through the same tools (milestone 78, planned).
Changes ADR-0021 (the vault tools), ADR-0049 (live edit), ADR-0063 (the
tool groups) and ADR-0069 (the explore tools); each gets its later-change
note with the milestone that changes it.

## Context

The assistant's tool use was unreliable, and an audit of the code showed
that it was not one defect but the absence of a design.

- **Two tool families for the same job.** The base set
  (`vault_search` / `vault_read` / `vault_write`, ADR-0021) and the
  assistant's explore tools (`vault_overview` / `vault_find` /
  `vault_section`, ADR-0069) overlap, name their vault argument
  differently (`vault` / `vaultId`) and answer in different formats.
  `tasks_list` existed twice, with different defaults.
- **No way to change part of a file.** `vault_write` replaces or appends
  a whole file. Exact replacement existed only for the open note in
  live-edit mode (`doc_apply_diff`, ADR-0049); an ordinary ask returns
  the whole document in a `document` fence. `vault_read` had no range,
  no line numbers and no limit; nothing searched inside one file.
- **Gating was an offer, not a rule.** The host ran every tool name the
  model emitted that was not a plugin or external tool — including a
  vault tool the group switch or the Vault chip's scope had left out of
  the offer. `vault_write` ignored the scope altogether.
- **A loop that failed on the first slip.** Two copies of the loop, one
  per provider. A tool that threw failed the whole ask; arguments were
  never checked; every HTTP 400 was read as "this server has no tool
  support"; at the round cap the reply was empty, the turn was discarded
  and its writes stayed on disk. The cap was a ladder (3 / 5 / 6 / 8 /
  16) keyed on which tools happened to be attached. Nothing showed in
  the panel until the turn was over.
- **A system prompt made of notes.** Ten optional strings joined in a
  fixed order. Some named tools the provider could not run; the base
  text ("two reply forms, nothing else") contradicted the tools note
  next to it; without the Vault chip the whole guidance on tools was one
  sentence.

How agent systems usually solve this (Anthropic's "Writing tools for
agents", Claude Code's file tools, aider's edit formats): few tools with
distinct jobs under one naming scheme; search by listing, searching and
reading, with retrieval beside it rather than instead of it; a read tool
with line numbers, a range and a default limit that says how to continue;
edits as an exact search-and-replace that must match once, applied
all-or-nothing; errors worded so the model can correct the call; results
capped with a hint; what a tool does in its description, and in the
system prompt only the rules that cut across tools — for the tools that
are actually attached.

## Decision

### 1. One tool loop (milestone 76)

`electron/llm/tool-loop.ts` runs the loop for both HTTP providers. A
provider supplies one function that performs a single request in its
dialect and returns the reply in the canonical shape (text, tool calls,
"cut off by the output limit"); `runToolLoop` does the rest:

- **Only an offered tool runs.** A name that is not in the request's
  tool list gets `Error: there is no tool "x" — the tools you can call
  are: …`. The host dispatcher holds the same rule one level down: each
  name runs where it was offered from (plugin, vault set, external), and
  a name that was not offered runs nowhere. The base `tasks_list` is no
  longer handed to plugin calls — the assistant brings its own and
  leaves it out on purpose where the index would answer for the wrong
  vault.
- **Arguments are checked before the tool runs**
  (`shared/llm/tool-args.ts`): valid JSON, required arguments present,
  primitive types and `enum` values of the top-level properties. A
  number or boolean sent as a string is repaired. Every refusal names
  the argument and what the tool takes.
- **A failure is a result, not an exception.** A tool that throws
  returns `Error: <tool> failed — <message>`. `Error:` at the start of a
  result is the one convention for "this did not work" across all tools.
  A cancellation still propagates.
- **Results are capped** at 16 000 characters with a line that says to
  narrow the call. The tools' own, lower limits stay.
- **A reply cut off by the output limit never runs its calls** — the
  arguments are half-written. The model is told to send smaller ones.
- **A call written into the reply text is read**
  (`shared/llm/text-tool-calls.ts`): `<tool_call>{…}</tool_call>` and a
  reply that is nothing but a JSON call, fenced or bare — only for a
  tool that was offered, only when no native call came.
- **One round budget**, the user's: `tools.maxRounds` (default 12,
  1–50, Settings → Assistant tools), applied by the host to every call
  that does not name its own. A live-edit turn gets at least 16.
- **A closing round instead of an empty reply.** When the budget is
  used up, or tools ran and the model then said nothing, the loop asks
  once more with the instruction to answer from what it has, and
  forbids a call (`tool_choice: none`; the declarations stay, because a
  transcript holding tool calls needs them).
- **HTTP 400 drops the tools only on the first request.** After a tool
  has run, a 400 is an error. A dropped tool set is reported
  (`LlmChatResult.toolsDropped`): the assistant asks again with a prompt
  that names no tools and remembers the model for the session.
- **Progress** (`onToolEvent`, SDK 1.23): one `start` and one `end` per
  call. The assistant forwards them (`chat:toolEvent`) and the panel
  shows each call in the streaming card while it runs.

Where tools ran and the model still gave no answer, the turn is kept
with its trace and a line that says so — a write may already be on disk,
and the record of it must not disappear with the turn.

### 2. One system prompt builder (milestone 76)

`plugins/assistant/main/system-prompt.ts` builds the prompt from fixed
parts, in this order: **role** (the mode's base text), **environment**
(the date, the vaults in scope, the vault ids the tools take), **vault
context** (the retrieved sections), **tools** (one line per attached
tool family with its write rule), **how to work with tools**, and the
wikilink rule.

The rule the builder exists for: **the prompt names a tool only when
that tool is attached to this call.** A provider without a tool loop, a
group that is off and a scope that leaves a tool out all get a prompt
that does not mention it. What a single tool does and takes belongs in
the tool's description; the prompt holds what cuts across tools — call
one only when the question needs it, look up before stating, make the
call instead of describing it, correct a failed call instead of
repeating it, narrow a cut-off result, change only what was asked,
finish with an answer in prose.

Tool results of earlier turns are shortened to 2 000 characters when the
conversation is replayed. The chat note keeps them in full.

### 3. One vault toolset for the assistant and the MCP server (milestone 77)

`vault_list`, `vault_search` (text, regex, tags; optionally inside one
file or folder, with context lines), `vault_retrieve` (semantic; offered
only while a semantic provider is registered), `vault_read` (numbered
lines, a range or a heading, a default limit with a continuation hint),
`vault_edit` (exact replacement that must match once, all-or-nothing),
`vault_write` (`mode` create / overwrite / append, required),
`vault_move` (with the link rewrite of ADR-0059) and `vault_delete`
(recycle bin, always asked). They replace the base three and the
assistant's explore tools and second `tasks_list`. One implementation in
the base, used by the MCP server and the assistant — ADR-0021's "no
parallel write logic" stays.

**The Vault chip is the scope of reading and writing**, enforced where
the tool runs: a `vault` argument outside the scope is refused, and with
the chip off no vault tool is attached. The vault group in Settings
becomes the write permission (`off` / `confirm` / `auto`); the read
tools follow the chip, as the explore tools did.

### 4. The open note through the same tools (milestone 78)

Main asks the renderer for the buffer of an open file. A read sees
unsaved text; an edit of an open file lands in the tab — in live-edit
mode at once and unsaved, otherwise after the ADR-0011 diff. The
`doc_*` tools go. The whole-document `document` fence stays as the
protocol for providers without a tool loop and for a model that refused
the tools.

## Considered and rejected

- **New tools for the assistant only, the MCP server unchanged.** No
  break for connected programs, but two families of read and write
  logic for good.
- **Unified diffs as the edit format.** Line offsets and hunk headers
  are what models get wrong; an exact search-and-replace needs neither
  and fails loudly when the text is not there.
- **Validating arguments with a JSON-Schema library.** The slips that
  occur are shallow (broken JSON, a missing argument, a string for a
  number); a full validator would add a dependency and messages written
  for programmers, not for the model that has to act on them.
- **Raising the round cap instead of closing the loop.** A higher cap
  only moves the point at which the turn is lost.
- **Leaving the reply to a prompt that named dropped tools.** One
  generation saved, an answer that announces lookups it could not make.
- **Streaming the tool-carrying request.** Wanted, but a separate change
  to both providers' wire handling; progress events cover the "is it
  doing anything" question for now. Follow-up on the roadmap.

## Consequences

- `PLUGIN_API_VERSION` minor 22 → 23: `MainChatOptions.onToolEvent`;
  `onToolCall` receives arguments that were already checked and may
  throw without failing the call; `maxToolRounds` defaults to the user's
  setting. Additive.
- `ToolsConfig` gains `maxRounds`.
- A plugin call with `vaultTools: true` no longer gets `tasks_list` from
  the base set.
- An ask whose tools ran but whose model stayed silent is no longer an
  error: it persists with a fixed answer line.
- An endpoint that rejects `tools` costs one extra request per model and
  session, not one per question.
- The prompt notes of ADR-0063 / ADR-0069 (`ASK_TOOLS_NOTE`,
  `ASK_SCOPED_TOOLS_NOTE`, `ASK_EXPLORE_NOTE`, `ASK_TASKS_NOTE`,
  `ASK_TEMPLATES_NOTE`, `ASK_WEB_NOTE`, the scope note) are gone; their
  content lives in the builder and in the tool descriptions.
- Milestone 77 changes the arguments of `vault_search` and `vault_write`
  for programs connected to Drey's MCP server.
- Not done in milestone 76: the abort signal still reaches only the
  external tools; plugin and vault tools finish the call they are in.
  The renderer-side `api.llm.chat` with `vaultTools` still attaches the
  whole base set (no plugin uses it); it follows in milestone 77.
