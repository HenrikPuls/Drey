# 2. Architecture Constraints

Fixed constraints carried over from `CLAUDE.md` / `specs/roadmap.md` —
these apply to every phase and are not up for reconsideration per-feature.

| Constraint | Rationale |
|---|---|
| Electron main/renderer split, no Node integration in the renderer | Security boundary; all filesystem/LLM access goes through a typed `contextBridge` IPC surface. |
| No server/backend process | A vault is just a folder on disk (can live on OneDrive); direct file access, no client-server split. |
| Storage is plain Markdown + YAML frontmatter | No proprietary format, no database as source of truth. See [`specs/frontmatter-schema.md`](../specs/frontmatter-schema.md). |
| Folder structure not hardcoded | Folders emerge dynamically per tag; the LLM proposes new folders, confirmed via the inbox. |
| Local LLM via LM Studio only, no hardcoded model id | No cloud calls; must not assume a specific model is loaded. |
| TypeScript strict mode, typed IPC interfaces | See "Coding & Style Conventions" in `CLAUDE.md`. |

## Technology constraints

Electron, Angular (standalone components), CodeMirror 6, chokidar,
transformers.js (WASM-only, in-app embeddings — the native
`onnxruntime-node`/`sharp` deps are stubbed, ADR-0055), LM Studio
(OpenAI-compatible HTTP API), electron-builder for packaging — Windows
NSIS installer + portable exe, config in `electron-builder.yml`
([ADR-0023](09_architecture_decisions/0023-windows-packaging-electron-builder.md),
[07_deployment_view.md](07_deployment_view.md)). No code signing yet.
