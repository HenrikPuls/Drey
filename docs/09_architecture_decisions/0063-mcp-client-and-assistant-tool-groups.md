# 63. The assistant reaches external tools through an MCP client; every tool group has one switch

## Status

Accepted (milestone 63, Req-31). Builds on ADR-0047 (tools reach every
provider that runs a tool loop) and ADR-0021 (the vault tool set).
Changes ADR-0021's "assistant tool use is gated by `mcp.enabled`" and
generalises the ADR-0011 later-change of milestone 58 into a rule. A
further documented exception to "no cloud calls", like the hosted
presets of ADR-0047: opt-in, off by default.

## Context

Two things were missing or crooked:

- **The assistant could not look anything up outside the vault.** Web
  search was the concrete wish; Jira (Req-17) is the next candidate of
  the same shape.
- **Tool gating had grown by accident.** The chat's `vault_*` tools hung
  on `mcp.enabled` — the switch for the server Drey offers to *other*
  programs — while `tasks_list` and `template_*` were always on. A
  `vault_write` asked first, a `template_write` did not, and the only
  way to change the former was the outward server's "YOLO mode".

Questions with real alternatives: how the client is built, when a call
that leaves the machine is asked for, where tools are switched, and what
the write rule is.

## Decision

**1 · An MCP client in main, on the official SDK.**
`electron/mcp-client/` holds `McpClientManager`: one
`@modelcontextprotocol/sdk` client per enabled server, over **stdio** (a
local command — most community servers) or **Streamable HTTP** (a hosted
server with a key header). Connecting is fire-and-forget at start and
after every settings save; a server that fails stays listed with its
error and a call to it retries once. **Tools only** — no resources,
prompts, sampling or OAuth.

A server's tools reach the model as `mcp__<serverId>__<tool>` (cut to 64
characters, the providers' limit). The id is a slug fixed when the
server is first saved, so a rename never changes tool names recorded in
chat notes. A result is flattened to text and capped at 20 000
characters, because it is persisted as a `drey-tool` line.

**The server Drey *offers* (ADR-0021) moves onto the SDK too.** Its
reason for being hand-written was "no SDK dependency", which this
milestone ends. `createVaultMcpServer` is the SDK's low-level `Server`
with two handlers over the unchanged `VaultTools`; the HTTP endpoint is
the SDK's Streamable HTTP transport, stateless and answering in plain
JSON. Two things improve on the way: the protocol version is negotiated
with the client instead of pinned to `2024-11-05`, and the endpoint
stops answering web pages — it used to send
`Access-Control-Allow-Origin: *` and check nothing, so with the endpoint
on, any page in a browser on this machine could call `vault_search` and
`vault_read`. Now a request needs a local `Host`, and an `Origin` (only
a browser sends one) must be local as well. The stdio bridge stays a
dependency-free script — an external `node` runs it from outside the
asar — and only gained the `Accept` header the transport requires.

**2 · A built-in `web_fetch`.** One tool that reads one http(s) URL and
returns Markdown (HTML through `turndown`, already a dependency; text
and JSON as they are; 20 s, 2 MB, 20 000 characters). It does not
search. Web search is whatever search MCP server the user adds — Drey
ships none and picks no vendor.

**3 · Calls that leave the machine are asked for, per source.** Every
external source — each server, and `web_fetch` as its own — has an
approval rule, `ask` (default) or `allow`. On `ask`,
`AssistantToolbox` pushes the call to the renderer
(`ToolApprovalBridge` → `ToolApprovalDialog`): source, tool, and the
exact arguments. Allow / **Always allow** (sets the source to `allow`) /
Deny; no window or no answer in two minutes means deny.

The reason is exfiltration, not cost: a search query or a URL is the one
way note content can leave through a tool, and a fetched page can carry
instructions aimed at the model. The dialog shows what would be sent;
the system prompt additionally tells the model not to put note text
into these arguments and to treat results as untrusted.

**4 · One switch per tool group, in one place.** A new config slice
`tools` and a Settings page **Assistant tools**:

| Group | Tools | Default | Extra rule |
| --- | --- | --- | --- |
| Vault | `vault_search` / `_read` / `_write` | off | write: confirm |
| Tasks | `tasks_list` | on | — |
| Templates | `template_*` | on | write: auto |
| Web fetch | `web_fetch` | off | approval: ask |
| MCP servers | `mcp__<id>__*` | none configured | approval: ask |

`mcp.enabled` and `mcp.yolo` now only govern the server offered to other
programs. A config from before this milestone has no `tools` slice; the
vault group then inherits `mcp.enabled` and `mcp.yolo`, so nobody's
assistant changes behaviour on update.

**5 · The write rule belongs to the group.** Each writing group is
`confirm` (the ADR-0011 diff first) or `auto`. The defaults are what
shipped before — notes ask, templates do not — but both are now the same
setting rather than one dialog and one exception.
`VaultTools.call` takes the rule from its caller: an MCP client follows
`mcp.yolo`, the assistant its group. Templates on `confirm` use the new
`ctx.vault.confirmWrite` port (SDK 1.15).

**6 · Plugins opt in per call.** `ctx.llm.chat` gains
`externalTools: true` (SDK 1.15) beside `vaultTools`. The host merges
plugin tools, the vault set and the external set — earlier wins a name
collision — and dispatches by name. The assistant passes it on ordinary
ask turns only: never on a live-edit turn (ADR-0049), never in Actions.

## Consequences

- With a search server connected the assistant can answer from the web
  and cite it; a call shows up as a tool chip ("server · tool") in the
  chat note like any other.
- New dependency: `@modelcontextprotocol/sdk` (pulls `zod`, `express`,
  `cors`, `eventsource`, `cross-spawn` into `node_modules`; only the
  client and server entry points Drey uses are imported). Pure JS, no
  native build step.
- For MCP clients of Drey's own server: a direct HTTP client must send
  `Accept: application/json, text/event-stream` (the specification
  requires it; without it the answer is 406), and a JSON-RPC batch that
  contains `initialize` is refused. The URL, the bridge configuration
  and the tools are unchanged.
- A stdio server is a child process running a command the user typed
  into Settings, with the user's rights. Nothing in a vault or a model
  reply can add or change a server.
- Keys in a server's environment or headers sit unencrypted in
  `app-config.json`, like the LLM keys (`docs/11`).
- Providers without a tool loop (the CLI providers) get none of this;
  the Settings page says so.
- Not covered: OAuth-protected servers; MCP resources and prompts; a
  per-chat or per-question tool switch; handing the configured servers
  to the Claude Code CLI (`--mcp-config`); external tools in live edit
  and in Actions.

## Considered and rejected

- **A hand-rolled client**, as the server was until now — no new dependency, but
  two transports, SSE framing, session headers and protocol-version
  negotiation to maintain against servers we do not control.
- **Never ask** (enabling a server is the consent) — convenient, and
  leaves no point at which the user sees what a model sends out.
- **Always ask, with no standing permission** — a five-search research
  turn becomes five dialogs; people would stop reading them.
- **A tools menu in the composer** — useful for "web just for this
  question", but more chrome in a tool row that is already full;
  deferred until the Settings switches prove too coarse.
- **Confirm every write, templates included** — uniform, but it
  interrupts the list → read → write flow of the template tools for
  content that is recoverable from the recycle bin.
- **A bundled search provider** — a vendor choice and a key the app
  would have to own.
