# 47. LLM provider abstraction (base-owned `LlmClient` + router; opt-in cloud providers)

## Status

Accepted — amends the roadmap's "local-only" core principle (every cloud
provider is a documented, opt-in preset, off by default, like the
`copilot-web` exception of [ADR-0040](0040-copilot-web-llm-provider.md))
and [ADR-0044](0044-runtime-plugin-system.md)'s frozen-SDK rule for one
documented break (`ctx.llm.chat` now returns `LlmChatResult`). The
concrete `LmStudioClient` extraction was prototyped on the
`feat/copilot-web-provider` branch (ADR-0040); this ADR supersedes that
draft's shape.

## Context

Until now the app had exactly one LLM transport: `LmStudioClient`, a
concrete class with no interface, referenced directly by `main.ts`, the
plugin host, the IPC handlers and the `TagSuggester`. It speaks the
OpenAI-compat dialect only, never streams, and runs the vault tool loop
inside `chat()`.

Req-29 adds five more backends: OpenRouter (OpenAI-compat, hosted,
vendor-prefixed model slugs), Z.ai GLM and the Anthropic API (both
speak the Anthropic Messages dialect — the GLM Coding Plan exposes an
Anthropic-compatible endpoint), Claude Code headless (`claude -p`, with
`--resume` sessions), and the GitHub Copilot CLI — plus the re-applied
`copilot-web` scraper (ADR-0040). Req-30 (chats as vault notes) needs a
provider-aware history policy, and Req-31 (an MCP client) needs its
tools to reach every backend that can call them.

The seam had to be decided before the first new provider landed:
retrofitting it afterwards would re-touch the plugin-SDK surface twice.

## Decision

**Interface-first, base-owned, with a "two-dialect rule".**

1. **One narrow interface in the main process** —
   `electron/llm/llm-client.ts`:

   ```ts
   export interface LlmClient {
     readonly id: LlmProviderId;
     capabilities(): LlmCapabilities;
     listModels(override?: LlmEndpoint): Promise<string[]>;
     testConnection(override?: LlmEndpoint): Promise<LlmConnectionTest>;
     chat(messages: ChatMessage[], options?: LlmChatOptions): Promise<LlmChatResult>;
   }
   ```

   It stays out of `shared/` on purpose (`LlmConnectionTest` lives in
   `shared/ipc-api.ts`, which already type-imports `shared/llm`; an
   interface there would close an import cycle for no gain) — the same
   reasoning the ADR-0040 branch recorded.

   - `LlmChatOptions` = `{ temperature?, signal?, tools?: ToolSpec[],
     onToolCall?, maxToolRounds?, onDelta?, sessionRef?,
     attachments?, maxOutputTokens? }`. **Streaming is an
     `onDelta` callback**, not an async iterator: it matches the
     existing option-bag style, the consumer is a push channel with no
     backpressure, and `chat()` stays a plain promise — one CLI spawn is
     naturally one promise. Providers that cannot stream must call
     `onDelta` exactly once with the full text, so callers have one
     code path.
   - `LlmChatResult` = `{ text, sessionRef?, usage? }` (was: plain
     string). `sessionRef` carries Claude Code's session id out of
     `chat()` and back in via `options.sessionRef` (`--resume`).
   - **Cancellation stays OUTSIDE the error taxonomy**: providers keep
     rejecting with the fetch `AbortError` (CLI providers kill their
     process tree and reject with `name: 'AbortError'`), so
     `isAbortError`, `LlmTaskRegistry` and every existing catch path
     survive untouched. ADR-0014's rules — no generation timeout,
     renderer-minted task id, cancel → noop — hold for every provider.
   - Everything else maps onto a small `LlmError` code set
     (`disabled | no-model | auth | http | bad-reply | spawn |
     unsupported`).

2. **Capabilities, not per-provider parameters.**
   `LlmCapabilities = { tools, streaming, sessions, modelListing,
   imageAttachments }` — a provider *declares what it cannot do* instead
   of the interface growing flags. Callers degrade by capability
   (e.g. tools are simply not offered to Claude Code, which runs its own
   agent loop). A static copy of each provider's capabilities lives in
   the config presets for Settings hints; `capabilities()` is the
   runtime truth. The small duplication is accepted and documented.

3. **`ChatMessage` stays OpenAI-shaped** as the canonical internal
   format. It is already the currency on both sides of the plugin IPC,
   it is the native dialect of the largest provider family (LM Studio,
   Ollama, vLLM, llama.cpp, Unsloth, OpenRouter), the Anthropic
   conversion is two pure functions, and CLI flattening is one.
   Attachments ride in `options`, not in content parts, precisely to
   leave `ChatMessage` untouched.

4. **`ToolSpec` replaces `tools: unknown[]`** as the canonical tool
   description (`{ name, description, parameters }`, JSON-Schema
   parameters — the vault tool defs already conform). The pure wire
   adapters live in `shared/llm/adapters.ts` — the fragile part belongs
   under the Vitest suite (ADR-0007), so they sit in shared, not beside
   the providers — mapping to the OpenAI wrapper and the Anthropic
   `{ name, description, input_schema }` shape, plus the full
   message-transcript conversion for Anthropic (system lift-out,
   `tool_use`/`tool_result` blocks, role merging).
   `VaultTools` exposes `toolSpecs(): ToolSpec[]`; the OpenAI wrapping
   moved into the openai-compat provider.

5. **Router, per call.** `LlmRouter implements LlmClient` re-reads
   `config.get().llm.provider` on every call — switching providers in
   Settings applies on the next request, no restart (the ADR-0040
   draft's rule). Providers live under `electron/llm/providers/`
   (one file per client, plus `cli-base.ts` for the spawn/kill/parse
   machinery shared by the two CLI backends) behind the module barrel.

6. **Providers are presets in config.** `LlmConfig` gains one field,
   `provider: LlmProviderId` (`'lmstudio' | 'openai-compat' |
   'openrouter' | 'anthropic' | 'zai-glm' | 'claude-code' |
   'copilot-cli' | 'copilot-web'`); `PROVIDER_PRESETS` in
   `shared/config/schema.ts` carries label, client class, default base
   URL, whether an API key is required, the static capabilities and
   which Settings field group to render. The existing
   `baseUrl`/`apiKey`/`model` fields remain the shared HTTP endpoint
   fields — all four HTTP presets need exactly those three.
   `normalizeAppConfig` migrates by defaulting absent/unknown values to
   `'lmstudio'`.

7. **Two-dialect rule.** The interface is proven against the two real
   HTTP dialects (openai-compat, anthropic-messages) before any CLI or
   scraping provider is built. If a CLI provider forces an interface
   change, the change is cheap — four call sites (`main.ts`, the plugin
   host's two chat sites, `TagSuggester`).

8. **One documented plugin-SDK break.** `MainPluginContext.llm.chat`
   returns `Promise<LlmChatResult>` and gains an in-process `onDelta`
   option; the renderer-side `api.llm.chat` keeps its serialized,
   string-returning shape and gains an `onDelta` push subscription
   (mirroring `onDebugEntry`). All in-repo consumers are updated in the
   same commit; the owner is currently the only plugin author.

## Consequences

- Every provider honours the same contract: ADR-0014 cancellation
  semantics, the debug log (entries gain a `provider` field), and the
  Settings probe endpoints (`llm:list-models` / `llm:test-connection`
  with an `LlmEndpoint` override) keep working unchanged.
- Cloud providers are **opt-in presets, off by default**: the app
  behaves exactly as before until a provider with a base URL outside
  localhost is selected and its API key entered. Keys sit in
  `app-config.json` in plain text — the same trade-off every desktop
  LLM client makes (`docs/11`), now for remote keys.
- The ADR-0040 branch's `LlmClient`/`LlmRouter` files cherry-pick
  cleanly, but its ActionRunner/renderer touchpoints predate the plugin
  host — the copilot-web provider is **re-applied**, not rebased, and
  only after the two HTTP dialects and the CLI providers prove the
  interface (its scraping module stays removable).
- Tool support is capability-gated: vault/MCP tools reach openai-compat
  and anthropic-messages providers; Claude Code and the copilot pair
  run without Drey's tool loop (Claude Code deliberately — its `-p`
  mode executes its own agent loop, so a Drey-side loop would double
  the tool surface and bypass nothing but our own confirmation bridge).
- Future knobs (`--allowedTools` for Claude Code, per-server MCP tool
  policy, streamed tool-call deltas) have reserved room in the options
  bag and the capabilities descriptor without another interface break.
- _(Later change, milestone 63, [ADR-0063](0063-mcp-client-and-assistant-tool-groups.md):
  the reserved "per-server MCP tool policy" exists. External MCP servers
  and a built-in `web_fetch` are a third tool source beside plugin tools
  and the vault set, merged in the plugin host behind
  `externalTools: true`; each source has an approval rule. They are a
  further opt-in exception to "no cloud calls", off by default. The CLI
  providers still get no Drey-side tools.)_
