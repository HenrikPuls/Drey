# 9. Architecture Decisions

Index of Architecture Decision Records (MADR-style: Title, Status,
Context, Decision, Consequences). One file per decision under
[09_architecture_decisions/](09_architecture_decisions/), numbered
sequentially. Written for structural/lasting decisions with real
trade-offs — not for routine implementation choices (a specific npm
package, a minor naming convention).

| #                                                                                 | Title                                                                                               | Status                         |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------ |
| [0001](09_architecture_decisions/0001-electron-process-split-contextbridge.md)    | Electron main/renderer process split via contextBridge                                              | Accepted                       |
| [0002](09_architecture_decisions/0002-quick-capture-opens-daily-note.md)          | Quick-capture opens the day's daily note in the editor (no popup)                                   | Accepted                       |
| [0003](09_architecture_decisions/0003-multi-document-editor-tab-model.md)         | Multi-document `EditorService` and the tab model (incl. unsaved daily-note drafts)                  | Accepted                       |
| [0004](09_architecture_decisions/0004-auto-switch-editor-mode.md)                 | Auto-switch editor mode and source↔rendered caret sync                                              | Superseded by [0008]           |
| [0005](09_architecture_decisions/0005-tag-first-classification.md)                | Tag-first classification vs. LLM-per-capture                                                        | Superseded by [0017]           |
| [0006](09_architecture_decisions/0006-master-document-tag-mechanism.md)           | Master-document / tag mechanism                                                                     | Superseded by [0017]           |
| [0007](09_architecture_decisions/0007-on-save-tag-pipeline.md)                    | On-save tag pipeline (`note:save`), routing as an append-copy                                       | Superseded by [0017]           |
| [0008](09_architecture_decisions/0008-editor-mode-menu-and-rendered-preview.md)   | Editor mode menu, shared typography, markdown-it rendered preview                                   | Partially superseded by [0009] |
| [0009](09_architecture_decisions/0009-live-preview-decorations.md)                | Live Preview via CodeMirror decorations (conceal + block widgets)                                   | Accepted                       |
| [0010](09_architecture_decisions/0010-app-settings-storage.md)                    | App settings in a user-data config file, not the vault                                              | Accepted                       |
| [0011](09_architecture_decisions/0011-unified-confirmation-flow.md)               | One confirmation flow for Actions and Ask-mode edits                                                | Accepted                       |
| [0012](09_architecture_decisions/0012-note-assistant-sidecar-thread.md)           | Note assistant thread in a sidecar file, not in the note                                            | Accepted                       |
| [0013](09_architecture_decisions/0013-inline-spellcheck.md)                       | Inline spellcheck: nspell in main, decorations in CodeMirror                                        | Accepted                       |
| [0014](09_architecture_decisions/0014-no-chat-timeout-cancellable-tasks.md)       | No generation timeout; explicit Cancel + a visible clock                                            | Accepted                       |
| [0015](09_architecture_decisions/0015-editor-content-zoom.md)                     | Editor content zoom (Ctrl +/−/0), not whole-window zoom                                             | Accepted                       |
| [0016](09_architecture_decisions/0016-feature-module-convention.md)               | Feature-module convention (thin barrels + ESLint-enforced boundaries)                               | Accepted                       |
| [0017](09_architecture_decisions/0017-tags-as-labels-and-section-index.md)        | Tags as free labels + an inverted section index + tag search                                        | Accepted                       |
| [0018](09_architecture_decisions/0018-manual-refresh-no-file-watcher.md)          | Manual refresh instead of a file watcher (Variant B)                                                | Accepted                       |
| [0019](09_architecture_decisions/0019-movable-dock-panels-and-layout-state.md)    | Movable dock panels, a custom titlebar, and one layout state                                        | Accepted                       |
| [0020](09_architecture_decisions/0020-app-wide-appearance-accent-and-ui-scale.md) | App-wide Appearance: highlight colour (`--accent` + `color-mix` tints) + UI scale (`setZoomFactor`); Appearance later moved into the draft / Save / Discard flow with live preview | Accepted (amended) |
| [0021](09_architecture_decisions/0021-mcp-vault-server.md)                        | MCP vault server (hand-rolled JSON-RPC, stdio + HTTP) + assistant vault tool use                    | Accepted                       |
| [0022](09_architecture_decisions/0022-configurable-entry-templates.md)            | Configurable "Add entry" templates (placeholder patterns, built-in re-injection, parser tweak)      | Accepted                       |
| [0023](09_architecture_decisions/0023-windows-packaging-electron-builder.md)      | Windows packaging with electron-builder (`electron-builder.yml`, `output: release`, `asarUnpack`)   | Accepted                       |
| [0024](09_architecture_decisions/0024-binary-vault-asset-write.md)                | Binary vault asset write (`vault:save-asset`) for pasted images + per-note `attachments/`           | Accepted                       |
| [0025](09_architecture_decisions/0025-mermaid-live-preview.md)                    | Mermaid diagrams in Live Preview (lazy `import('mermaid')`, block widget, Live-Preview-only)        | Accepted                       |
| [0026](09_architecture_decisions/0026-image-viewer-and-lightbox.md)               | Image viewer: shared zoom/pan component, fullscreen lightbox, `kind: 'image'` tabs, `![alt\|W]` sizing | Accepted                       |
| [0027](09_architecture_decisions/0027-window-dnd-navigation-guard.md)             | Window-level drag-and-drop navigation guard (capture-phase renderer service + `will-navigate`)     | Accepted                       |
| [0028](09_architecture_decisions/0028-drag-drop-into-the-editor.md)               | Drag-and-drop into the editor: link vault images in place, inline text files, download web images (`vault:save-asset-from-url`) | Accepted |
| [0029](09_architecture_decisions/0029-template-library.md)                        | Template library: a configurable vault sub-folder, folder = category, insert at cursor (frontmatter stripped, placeholders substituted) | Accepted |
| [0030](09_architecture_decisions/0030-renderer-editor-context-menu.md)            | Renderer-owned editor context menu, replacing the OS menu (`formControlType` gate) | Accepted |
| [0031](09_architecture_decisions/0031-editor-link-activation.md)                  | Ctrl/Cmd-click to open a link in the editor (web via `shell.openExternal`, vault path as a tab) | Accepted |

Decisions not yet written up (relevant spec already fixes them, but the
ADR is deferred to the milestone that actually implements them, per
`CLAUDE.md`'s "fill in incrementally" guidance):

- Storage format: plain Markdown + YAML frontmatter, no database
  (relevant from milestone 2, vault/file access)
