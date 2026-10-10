# 21. MCP vault server + assistant vault tool use

## Status

Accepted — a Phase 1 addition on top of
[0011](0011-unified-confirmation-flow.md) (the confirmation flow it reuses
for writes), [0016](0016-feature-module-convention.md) (a new
`electron/mcp/` module), [0018](0018-manual-refresh-no-file-watcher.md)
(no watcher — writes push a refresh) and
[0010](0010-app-settings-storage.md) (the `mcp` config slice). Not present
in the original `specs/roadmap.md`; added to Phase 1 at the project
owner's request.

## Context

The project owner wanted an AI client (Claude Desktop and the like) to be
able to **read, search and write** the active vault, with the model able
to pass a **regex** to filter search results — and the built-in
assistant to use the same capability during a chat, rather than only
seeing the open document.

Two shape questions had real trade-offs and were settled with the owner:

- **How clients connect.** MCP clients that spawn a subprocess expect a
  stdio server; network clients want an HTTP endpoint. The roadmap's "no
  server process" principle is about the _vault data path_ (files on
  disk, no client/server split), but a listening socket is still a
  genuine departure. Decision: **both** transports, with the HTTP one
  **opt-in** on top of the master switch.
- **Whether to pull in `@modelcontextprotocol/sdk`.** It is ESM-only and
  brings transitive dependencies; the main process compiles to CommonJS
  (`electron/tsconfig.json`, `module: Node16`), and the project keeps its
  dependency list deliberately short. A tools-only MCP server is a small,
  stable JSON-RPC surface (`initialize`, `tools/list`, `tools/call`,
  `ping`, the `notifications/*` no-ops). Decision: **hand-roll it**
  (~120 lines), keeping `.tools/` deletable and the surface auditable.

- **What gates a model-driven write.** The owner's call: **confirm every
  write** through the existing diff dialog, plus a **"YOLO mode"** switch
  in Settings that skips it — off by default, and meant to stay off.

## Decision

**A transport-agnostic MCP server over one vault tool set, in a
`electron/mcp/` feature module, consumed three ways.**

`shared/app-config.ts` grows `mcp: { enabled, httpEnabled, httpPort,
yolo }` (all off / `4319` by default, `httpPort` clamped 1024–65535),
guaranteed present by `normalizeAppConfig` like every other slice.

`electron/mcp/`:

- **`vault-tools.ts`** — `VaultTools`, the three tools and their JSON
  schemas:
  - `vault_search` — `tags` (AND) + `text` (AND) run through the same
    `runTagSearch` the sidebar uses; an optional `regex` (+ `regexFlags`,
    default `i`) filters the matched section bodies. With **only** a
    `regex`, every Markdown file is line-scanned instead (the "grep the
    vault" path), bounded by `SCAN_MAX_FILES` / `SCAN_MAX_BYTES_PER_FILE`.
  - `vault_read` — one file, vault-relative path.
  - `vault_write` — `overwrite` (default) or `append`; reads the current
    file, computes `before`/`after`, and — unless `mcp.yolo` — calls a
    `ConfirmWrite` callback before `VaultManager.writeFile`. On success it
    reindexes the file (`TagIndex.reindexFile`) and fires an
    `onVaultChanged` hook.
  - All IO is `VaultManager`, so the vault-escape guard (`..`, absolute,
    no active vault) is unchanged.
  - `openAiToolSpec()` re-expresses the same defs in OpenAI `tools`
    shape for the assistant loop — one definition, no drift.
- **`server.ts`** — `McpServer.handle(message)`: JSON-RPC 2.0 dispatch,
  returns the response object or `null` for a notification. No IO, no
  transport — unit-tested with a fake `VaultTools`.
- **`http-transport.ts`** — `McpHttpTransport`: one `POST /mcp` on
  `127.0.0.1:<port>` taking a JSON-RPC message or batch (the "Streamable
  HTTP" shape minus the optional SSE stream — a tools-only server never
  pushes). Started/stopped by `syncMcpHttpTransport` to match
  `enabled && httpEnabled`, on boot and after every `config:set`.
- **`stdio-bridge.ts`** — a standalone script (added to
  `electron/tsconfig.json`'s `include` so it is emitted; nothing imports
  it) that MCP clients spawn with `node`. It proxies newline-delimited
  JSON-RPC on stdin/stdout to the localhost HTTP endpoint, port from
  `DREY_MCP_PORT`. Settings → MCP shows the exact `mcpServers` config
  block, with the resolved absolute path.

**Write confirmation bridge (main ↔ renderer).** `VaultTools`'
`ConfirmWrite` in `main.ts` mints an id, `webContents.send`s an
`mcp:write-request` (`{ id, path, before, after, mode }`), and awaits a
pending-promise resolved by the `mcp:write-decision` IPC reply — or a
120s timeout / no window, both defaulting to **reject**. Renderer:
`McpBridgeService` (instantiated by `App`) shows the change in the shared
`ConfirmationService` diff (`pickPreviewStyle` chooses inline vs.
side-by-side) and replies. It also listens for `mcp:vault-changed` and
calls `TagService.refresh()` / `VaultService.refresh()` (no watcher).

**Built-in assistant as an MCP client.** `LmStudioClient.chat` gains an
optional tool-calling loop: with `tools` + `onToolCall` it sends
`tools`/`tool_choice: auto`, and while the reply carries `tool_calls` it
runs each through `onToolCall`, appends the `tool` results and loops
(cap 5 rounds). A `400` while `tools` were sent drops them and retries
once (capability fallback). `ChatMessage` gained `'tool'` role +
`tool_calls` / `tool_call_id` (and `content: string | null`).
`ActionRunner.ask` passes `VaultTools.openAiToolSpec()` +
a `runVaultTool` bridge **only when `mcp.enabled`** and a `VaultTools`
instance was injected, and appends a one-line tools note to `ASK_SYSTEM`.

## Consequences

- One tool set, one confirmation path, three consumers (external stdio
  client, external HTTP client, in-process assistant). No parallel
  write logic.
- The HTTP endpoint is a real listening socket — localhost-only,
  off by default, and clearly a Phase 1 departure from "no server". The
  stdio bridge still needs it running (it is a thin HTTP proxy); a direct
  stdio server with no socket is a possible future refinement.
- YOLO mode lets a model — local or a remote client's — overwrite vault
  files with no review. It is off by default, guarded in the UI, and the
  only path that skips the diff.
- The regex scan is O(files × lines) with a fixed cap; fine for a
  single-user local vault, not a general-purpose search index.
- No `@modelcontextprotocol/sdk` dependency. If MCP's wire protocol
  evolves past what `server.ts` handles, that is a hand-maintenance cost
  we accepted for the smaller surface.
- Assistant tool use is gated by `mcp.enabled` (default off), so the
  no-tools Ask path — and its cost/latency profile — is completely
  unchanged for everyone who has not opted in.
- _(Later change, milestone 63, [ADR-0063](0063-mcp-client-and-assistant-tool-groups.md):
  the assistant is no longer gated by `mcp.enabled`. Its vault tools
  follow `tools.vault.enabled`, and whether its `vault_write` asks
  follows `tools.vault.write` — `VaultTools.call` takes the write rule
  from its caller. `mcp.enabled` and `mcp.yolo` only govern MCP clients.
  A config from before that milestone carries both values over, so
  behaviour is unchanged on update. The "no SDK dependency" point above
  still holds for this server; the new **client** uses the SDK.)_
- _(Later change, same milestone: the protocol layer moved onto the SDK.
  `server.ts` is `createVaultMcpServer` — the SDK's low-level `Server`
  with `tools/list` and `tools/call` handlers over `VaultTools` — and
  `http-transport.ts` hands each `POST /mcp` to a fresh stateless
  Streamable HTTP transport (`enableJsonResponse`). The protocol version
  is negotiated instead of pinned. The permissive CORS described above is
  gone: a request needs a local `Host` and, if it carries an `Origin`, a
  local one — a web page can no longer reach the endpoint. A client must
  send the `Accept` header the specification asks for. The stdio bridge
  is still a plain proxy without dependencies. The "hand-rolled" and "no
  SDK dependency" statements above are superseded.)_
