# 0055 — Semantic vault retrieval for the assistant (RAG-lite via the Vault chip)

## Status

Accepted (milestone 41)

## Context

The assistant's only whole-vault access paths were the per-file context
chips (`+` picker / `@` completion) and the model-driven MCP tool loop
(`vault_search` / `vault_read` / `vault_write`, gated by `mcp.enabled`).
Both fit large models poorly:

- The tool loop needs reliable multi-round tool use — exactly what small
  local models (3B–8B) are bad at — and every round multiplies context.
- The chips require the user to know *which* file to attach.

For a daily-notes vault (chronological, rarely tagged, topics scattered
across many days) the missing piece was retrieval: answer questions over
the whole vault with a small, fixed amount of context. The owner runs
small local models and explicitly wants minimal context per question.

The roadmap (`specs/roadmap.md`, Phase 2) had sketched this as
"Semantic Search — embeddings via transformers.js + sqlite-vec, wired
into the 'all notes' chat scope (RAG)".

Two structural facts constrain the design:

- **No native modules** (ADR-0023: "no native modules → no rebuild
  step"). `sqlite-vec` would arrive through `better-sqlite3` — the app's
  first native dependency, with Electron-ABI rebuild + `asarUnpack`
  consequences.
- **No plugin-to-plugin calls** (ADR-0044): whatever retrieves must live
  where its consumer is. The roadmap scopes the feature to a single
  consumer ("sized for this one consumer only. Do not build a generic
  Job Queue subsystem yet").

## Decision

**Semantic retrieval inside the assistant plugin, driven by a composer
chip.** A **Vault chip** cycles `off → vault (active vault) → all →
off` (remembered per app in `localStorage['drey.assistant.vaultScope']`).
When on, the ask carries `vaultScope`, and the chat engine retrieves the
top-k sections most similar to the question and injects them into the
system prompt. No tool calls, a small fixed context, no dependence on
the model's tool ability.

**Embeddings run in-app via transformers.js (WASM), in a worker
thread.** `plugins/assistant/main/semantic/embed-worker.ts` is the only
module loading `@huggingface/transformers`. Because the package
statically requires the native `onnxruntime-node`, the app ships inert
stubs (`tools/stubs/*` as `file:` dependencies) and injects the WASM
backend through `globalThis[Symbol.for('onnxruntime')]` before the
library resolves. `sharp` (images — never used for text embedding) is
stubbed the same way; the build-time icon scripts use the real sharp
under the alias `sharp-images`. ADR-0023 stays intact: still no native
modules. Default model: `Xenova/multilingual-e5-small` (quantized,
384 dims, multilingual — the vault content is German), configurable;
e5 models get their `query:` / `passage:` prefixes automatically.

**No database.** The roadmap's `sqlite-vec` is dropped: one JSON file
per vault (`<userData>/plugins/assistant/semantic-index/<vaultId>.json`,
vectors as base64 float32, model id stamped) with brute-force cosine in
JS covers personal vault sizes in milliseconds and keeps ADR-0010's
"no database" principle untouched. A model change marks an index stale
and search skips it until rebuilt.

**Sections, not files, are the retrieval unit** — the same shape the
tag index established (heading-delimited, fence-aware; the pure
splitter is copied from `plugins/tags/shared/sections.ts`, since
cross-plugin imports are banned). Section text is never persisted in
the index; retrieval hydrates it fresh from the vault at answer time,
so a stale index degrades rankings, never content.

**Context stays small on follow-ups.** Retrieved text rides ONLY the
system prompt of the current call — never the replay. The chat note
persists a compact `drey-context` fence (paths + headings + lines,
rendered as a collapsible chip); older turns replay it as a single
`[Vault context used …]` line. Live-edit turns ignore the scope (the
document plus the tool loop is context enough).

## Consequences

- The assistant reaches the whole vault with ~1–2k tokens of context,
  independent of the MCP switch and of the model's tool ability.
- First enablement triggers a background catch-up build (embed every
  section, ~30 ms each single-threaded WASM, progress in Settings →
  "Assistant retrieval", crash-resumable by construction); saves
  re-embed one file incrementally.
- New dependency surface: `@huggingface/transformers` (pinned),
  `onnxruntime-web`/`onnxruntime-common`, two local stub packages; the
  ORT WASM glue and the embed worker are `asarUnpack`ed (dynamic
  `import()` cannot target asar paths).
- One-time model download from the Hugging Face hub on first build
  (cache under `<userData>/models`) — a documented cloud touch like
  ADR-0047's opt-in presets, locally cached afterwards.
- The MCP `vault_search` stays keyword-based; a semantic MCP tool would
  need a base registry seam (the section-search slot is single) —
  deliberately deferred until a second consumer exists.
