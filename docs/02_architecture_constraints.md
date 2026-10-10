# 2. Architecture Constraints

Fixed constraints carried over from `CLAUDE.md` / `specs/roadmap.md` —
these apply to every phase and are not up for reconsideration per-feature.

| Constraint | Rationale |
|---|---|
| Electron main/renderer split, no Node integration in the renderer | Security boundary; all filesystem/LLM access goes through a typed `contextBridge` IPC surface. |
| No server/backend process | A vault is just a folder on disk (can live on OneDrive); direct file access, no client-server split. |
| Storage is plain Markdown + YAML frontmatter | No proprietary format, no database as source of truth. See [`specs/frontmatter-schema.md`](../specs/frontmatter-schema.md). |
| Folder structure is the user's own | The app imposes only `templates/`, the daily-notes root, `chats/` and the hidden `.drafts/`; topics are free inline `#tag` labels, never directories (ADR-0017). |
| Local LLM by default, no hardcoded model id | The default is a local OpenAI-compatible endpoint (LM Studio default). Cloud and CLI providers are documented, opt-in exceptions, each off by default (ADR-0047); must not assume a specific model is loaded. |
| TypeScript strict mode, typed IPC interfaces | See "Coding & Style Conventions" in `CLAUDE.md`. |

## Technology constraints

Electron, Angular (standalone components), CodeMirror 6, chokidar,
transformers.js (WASM-only, in-app embeddings — the native
`onnxruntime-node`/`sharp` deps are stubbed, ADR-0055), LM Studio
(OpenAI-compatible HTTP API), electron-builder for packaging — Windows
NSIS installer + portable exe, config in `electron-builder.yml`
([ADR-0023](09_architecture_decisions/0023-windows-packaging-electron-builder.md),
[07_deployment_view.md](07_deployment_view.md)). No code signing yet.
