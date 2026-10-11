# 0069 — Agentic vault exploration for the assistant (hybrid RAG)

## Status

Accepted (milestone 71). Extends ADR-0055 — the fixed top-k retrieval
block stays, and gains a scope-safe tool loop beside it.

## Context

ADR-0055 answered "the whole vault, small fixed context" with pure
similarity retrieval: embed the question, inject the top-k sections
(default 4) into the system prompt, no tool calls. That baseline holds
for small local models, but it caps answer quality at what ~4 sections
happen to cover. Three structural gaps surfaced in practice:

- **No overview.** The model never sees the vault's structure — it
  cannot know what else exists, so it cannot tell "the context is thin"
  from "the vault has nothing on this".
- **Fixed k.** A broad question needs more than `topK` sections; a narrow
  one wastes context. The setting is global, not per question.
- **Scope leaks.** The Vault chip picked the retrieval targets, but the
  base `vault_search`/`vault_read` tools still defaulted to the ACTIVE
  vault — with a non-active selection the model could (and did) pull
  out-of-scope content through the tool loop. The picker compounded this:
  checking a vault from a shortcut scope ADDED to the shortcut's set, so
  "Active vault" + one checkbox silently queried both.

An agentic design was deliberately avoided in ADR-0055 (small local
models, no tool dependence). The resolution is hybrid: the injected block
stays the floor, and a SMALL, domain-fixed tool set covers the agentic
half for providers that can use it. The tasks/template/external tools
(SDK 1.11–1.15) already established the plugin-tool pattern and showed
the target models can run bounded loops.

## Decision

**Three plugin-owned explore tools (ADR-0049 pattern), closed over the
ask's scope.** When the Vault chip is on and the provider has tool
support, the ask carries `vault_overview` / `vault_find` /
`vault_section` beside the baseline block:

- `vault_overview` — one JSON row per file of the scoped vaults: vault,
  vaultId, path, section headings. Sourced from the loaded vector index
  (`VectorIndex.outline` — no re-read); a cold vault falls back to the
  flat file list and kicks its background catch-up (below). Capped at
  150 rows with an explicit truncation marker.
- `vault_find` — semantic search over the scope (`searchScoped`, the
  multi-vault variant the SDK seam's single-vault `search()` could not
  express), top-N with snippet + score, default 12 / cap 20.
- `vault_section` — one section's FRESH text by heading (case-insensitive)
  or 1-based line, ~2400-char cap; the read guard refuses vault ids
  outside the scope.

All three resolve their targets through `resolveTargetVaultIds` — the
chip's scope is enforced in code, and a `vaultId` argument can only
NARROW it. The narrowing maps to a `custom` selection of exactly that
id, because the resolver ignores the id list under `vault`/`all`. The
`ASK_EXPLORE_NOTE` prompt instructs scan-first-then-read and forbids
querying/citing vaults outside the tools' results. Loop cap: 6 rounds
(3→5→6→8 ladder by attached tool group, external still wins).

**Host-side scope enforcement (SDK 1.20).** `MainChatOptions` gains
`vaultToolsScope?: readonly string[]` — the ask's resolved target ids.
The plugin host drops `vault_search` and `vault_read` from the merged
tool set when the scope excludes the active vault (they default to it
and would leak out-of-scope reads); `vault_write` is never filtered, and
an absent scope keeps the pre-1.20 behaviour. The pure rule
(`vaultReadToolAllowed`) is spec-covered in the host.

**Cold vaults self-heal.** `ensureLoaded`'s silent skip became
`ensureUsable`: a vault whose index is missing, corrupt, or model-stale
gets a deduplicated fire-and-forget `rebuildVault` and is reported
unusable for THIS round — the search runs over the remaining targets,
the next ask uses the fresh index. A vault with no Markdown files never
triggers a rebuild (it would re-trigger forever). `RetrievalOutcome`
gained `targets` so the engine can pass the resolved scope to the host.

**Picker replace semantics.** The first CHECK from a shortcut scope
starts a fresh selection with just that vault (derive → `custom` or the
single-active `vault`); unchecking still operates on the visible list.
No silent carry-over of the shortcut's vaults.

## Consequences

- `PLUGIN_API_VERSION` minor 19 → 20 (additive `vaultToolsScope`).
- The context block, its citations, and the `drey-context` fence are
  unchanged; tool-driven reads surface through the existing tool-trace
  entries, not the fence.
- `searchScoped` returns the plugin-owned `RetrievedSection` shape — the
  SDK's `SemanticSectionHit` stays untouched (the Search panel and MCP
  consumers never see it).
- An explore turn costs at most ~6 bounded rounds; providers without the
  `tools` capability keep exactly the ADR-0055 behaviour (block, no
  tools, no note).
- The SDK seam's `search()` (Search panel, MCP) now also benefits from
  the readiness pass: a stale index no longer silently browses as empty,
  it rebuilds in the background and answers next round.
