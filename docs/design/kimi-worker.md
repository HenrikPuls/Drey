# Kimi Code as a fleet worker (E10-8)

Status: implemented in milestone 167. Pinned against `kimi` **2.4.1**
(Windows, logged in, 2026-11-05). Recorded from the real CLI on a scratch
folder; no repository was touched.

## What the CLI offers

| Surface | What it gives | Fit for the runner |
|---|---|---|
| `kimi -p "<prompt>" [--output-format stream-json]` | One prompt, prints the answer. **Always runs in Auto ("Never Ask") mode.** `stream-json` = one OpenAI-chat-style message per line (`assistant` with `tool_calls`, `tool`, `assistant` text, a closing `session.resume_hint` meta line). No thinking, no deltas, **no token usage, no cost**, no way to answer a question or an approval. | Rejected: unattended auto-approve, blind to usage, no steering. |
| `kimi acp` | Agent Client Protocol over stdio (newline-delimited JSON-RPC 2.0). Live tool calls, thought and answer chunks, `session/request_permission`, `session/cancel`, `session/load`, mode and model switches, a context meter. | **Chosen.** It is the one surface that keeps approvals and questions. |
| `kimi -S <id>` / `-c`, `kimi session list --json`, `kimi export/fork` | Resume and inspect sessions (interactive). | Resume goes through ACP `session/load` instead. |
| `kimi login`, `kimi doctor`, `kimi provider list` | Auth and config validation. | The probe. |

## ACP, as measured

Handshake: `initialize {protocolVersion: 1, clientCapabilities: {}}` →
`agentCapabilities.loadSession: true`, `agentInfo {name, version}`;
`session/new {cwd, mcpServers: []}` → `{sessionId, configOptions[model, thinking, mode]}`.

- **Brief and working directory**: the brief is the `session/prompt` text
  (`prompt: [{type: 'text', text}]`); the working directory is `cwd` of
  `session/new` / `session/load` (and the process cwd).
- **Model**: `session/set_config_option {sessionId, configId: 'model', value}`;
  values are `provider/alias` (`kimi-code/k3.1-pro`, `zai-coding-plan/glm-5.3`).
  Without it the session uses `default_model` of `~/.kimi-code/config.toml`.
- **Modes** (`session/set_mode {modeId}`): `default` = manual approvals,
  `plan` = read-only, `auto` = auto-approve safe operations, `yolo` =
  approve everything. (The `--yolo` / `--auto` flags of the interactive CLI
  use different words: `--yolo` = ask when needed, `--auto` = never ask.
  ACP's ids are the ones above.)
- **Stream** (`session/update` notifications): `agent_message_chunk`,
  `agent_thought_chunk` (text chunks), `tool_call` (`toolCallId`, `title` =
  tool name such as `Bash`/`Write`/`Glob`/`Read`/`Edit`, `kind` =
  read/edit/execute/other, `content[0].content.text` = the JSON arguments),
  `tool_call_update` (`in_progress` with `rawInput`; `completed`/`failed`
  with `rawOutput`), `usage_update {used, size}` (context tokens and the
  model's window, sent after the turn), `session_info_update`,
  `available_commands_update` (`compact`, `status`, `usage`, …),
  `config_option_update`, `current_mode_update`.
- **Approvals**: the agent sends a **request** `session/request_permission`
  (`params.options[]` = `approve_once` / `approve_always` / `reject`,
  `toolCall {toolCallId, title, content}`; Bash content reads "Requesting
  approval to Running: <command>"). The client answers the JSON-RPC id with
  `{outcome: {outcome: 'selected', optionId}}` or `{outcome: 'cancelled'}`.
  The request stays open for as long as the client takes: a live process
  can hold it for the owner.
- **Questions**: Kimi's `AskUserQuestion` tool arrives as the same request
  with `title: 'AskUserQuestion'`, `toolCall.content` = the question text,
  and one option per choice (`q<N>_opt_<M>`, name = the label) plus
  `q0_skip`. There is **no free-text answer**; the tool returns
  `{answers: {<question>: <label>}}`. The full question (header,
  descriptions, `multiSelect`) is in the preceding `tool_call` content.
- **End of a turn**: the `session/prompt` response `{stopReason}` —
  `end_turn`, `cancelled` (after `session/cancel`), others unseen. A prompt
  while a turn runs is refused: error `-32600`, `data.code:
  'turn.agent_busy'`.
- **Stop**: `session/cancel` (notification) ends the turn softly, the
  session and process stay; the hard stop is the process tree kill.
- **Compact**: `/compact` as a `session/prompt` text; answered
  `end_turn`. (Not observed to shrink on a 17 k session; the command is
  advertised and routes natively.)
- **Resume**: `session/load {sessionId, cwd, mcpServers: []}` replays the
  history as `session/update` notifications (the adapter suppresses them),
  then prompts continue the same context. A missing id is a JSON-RPC error.
- **Tokens and cost**: **not in the ACP stream.** Kimi writes every model
  call to `<home>/sessions/<workspace>/<sessionId>/agents/main/wire.jsonl`
  as `{"type":"usage.record","model","usage":{"inputOther","output",
  "inputCacheRead","inputCacheCreation"},"usageScope":"turn"}` (one per
  step; matches `step.end.usage`). `<home>` is `~/.kimi-code`. The adapter
  reads that file after each turn; cost is **computed** from
  `core/model-prices.ts` (Kimi rows already there), never reported by the
  CLI.
- **Quota / rate limit**: no distinct signal was provokable. A failing
  call surfaces as a JSON-RPC error on `session/prompt` (or a `failed`
  stop); the adapter turns any error into an `error` event whose text
  carries the CLI's message, so the runner's existing breaker/quota
  heuristics (text based) see it. Marked unverified.
- **Exit codes**: `kimi acp` exits 0 when stdin closes; a crash is non-zero.
  The runner reads the handle's `exited`, as for the other adapters.
- **Privacy**: Kimi's models are hosted (`api.kimi.ai`, `api.z.ai`).
  Opt-in only; the default worker stays opencode.

## The runner's contract and how Kimi maps

`ProviderAdapter { id, label, liveInject, spawn(start) → WorkerHandle }`
with `NormalizedEvent`s into the run log (the `claude-code` adapter is the
template).

| Runner need | claude-code | kimi (ACP) |
|---|---|---|
| Start with brief | `-p` + stream-json user message | `session/new` → mode → model → `session/prompt` |
| Session ref | `system.init.session_id` | `session/new` result `sessionId` |
| Resume | `--resume <ref>`; exit before init = failed resume | `session/load`; error = `onResumeFailed` |
| Thinking / text / tools | content parts | thought chunks, answer chunks, `tool_call` / `tool_call_update` |
| Edit line counts (`changes`) | tool input | `Write` (content) / `Edit` (new/old text) when the arguments carry them |
| Tokens, cost | `result` event | wire log after the turn + price table |
| Context | assistant usage | `usage_update {used, size}` |
| Permission wait | none (accept-edits/bypass flag) | `request_permission` → `waiting {kind:'permission'}` → `answerPermission` |
| Question wait | `QUESTION:` marker | `QUESTION:` marker **and** `AskUserQuestion` → `waiting {kind:'question'}` → `answerQuestion` |
| Steer | user message into stdin (`inject`) | idle: new prompt (`inject`); busy: cancel the turn, then prompt (`inject`) |
| Interrupt | control_request | `session/cancel` |
| Compact | `none` | `native` via `/compact` (only when a resumeRef exists) |
| Turn end | `result` event | `session/prompt` response |

Permission mode: `bypass` → ACP `yolo`; `accept-edits` → `auto`
(auto-approves safe operations, asks for the rest — the held request then
rides the card like OpenCode's). Both are overridable per column through
the existing permission setting.

## Limitations (follow-ups on the roadmap)

- No budget cap, no max-turns flag in the CLI (`capping` of the runner
  still applies from outside).
- AskUserQuestion has no free text: a typed answer that matches no option
  is delivered as a follow-up message after the question is skipped.
- Cost is computed from the editorial price table; an unknown model id
  yields tokens without cost.
- `holdAtSpawn` (quiet start) and `attach` (re-attach after a runner
  restart) are not offered: a CLI process dies with its runner.
- Rate-limit/quota stop reasons are unverified against a real limit.
