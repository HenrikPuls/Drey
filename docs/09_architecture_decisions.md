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
| [0012](09_architecture_decisions/0012-note-assistant-sidecar-thread.md)           | Note assistant thread in a sidecar file, not in the note                                            | Superseded (summary removed)   |
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
| [0032](09_architecture_decisions/0032-field-logging-and-input-recovery.md)        | Field log file + a manual/​watchdog "Recover input" escape hatch for the intermittent input lock | Accepted |
| [0033](09_architecture_decisions/0033-tasks-panel-and-index.md)                   | Tasks dock panel + whole-vault `TaskIndex` (checkbox / `#task` lines, `#task/done`, document = live buffer) | Accepted |
| [0034](09_architecture_decisions/0034-internal-widget-model.md)                   | Internal widget model: `WIDGETS` registry, `WidgetContext` capability facade, per-widget View-menu hide/show | Accepted |
| [0035](09_architecture_decisions/0035-named-ui-themes.md)                          | Named UI themes: `@uiw/codemirror-themes-all` catalog, shell palette derived from a per-theme seed, live compartment swap | Accepted |
| [0036](09_architecture_decisions/0036-code-file-editor-mode.md)                    | Non-Markdown files open in a read-oriented code mode: extension → language compartment, source-only, no Markdown chrome | Accepted |
| [0037](09_architecture_decisions/0037-split-view-editor-panes.md)                  | Split-view editor panes: a `PaneService` split tree, `EditorService` as a facade over the focused pane | Accepted |
| [0038](09_architecture_decisions/0038-editor-panes-in-docks.md)                    | Editor panes in the docks (split-view Phase 2): a `PaneService` region model, a dock "editor slot", no `WidgetDescriptor` involvement | Proposed |
| [0039](09_architecture_decisions/0039-drag-and-drop-chrome.md)                      | Drag-and-drop chrome: a shared `src/app/dnd/` overlay + ghost, deferred commit, `no-drop` feedback, `TabDragService` | Accepted |
| [0041](09_architecture_decisions/0041-calendar-file-drop-meeting-section.md)         | Drag an `.ics` / `.msg` onto the editor → a `#mtg/<slug>`-tagged meeting section: decode in main (`ical.js` + `@kenjiuno/msgreader`), render from an editable `templates/meeting.md`, insert at the drop point | Accepted |
| [0042](09_architecture_decisions/0042-in-editor-web-browser-tab.md)                | In-editor web browser tab: one main-process `WebContentsView` per `browser://` tab, `persist:webtab` session, `OverlayGuardService` for occlusion | Accepted |
| [0043](09_architecture_decisions/0043-session-history.md)                          | Session history: restore the pane layout + open tabs on launch; unsaved buffers backed up under user-data (Notepad++-style) | Accepted |
| [0044](09_architecture_decisions/0044-runtime-plugin-system.md)                    | Runtime plugin system: a base app with runtime-loadable, in-process plugins (supersedes 0016/0034's "no runtime" stance) | Accepted |
| [0045](09_architecture_decisions/0045-optional-vault-file-watcher.md)              | Optional vault file watcher: opt-in chokidar + own-write ledger + one shared external-change round; manual refresh becomes a full round (amends 0018) | Accepted |
| [0046](09_architecture_decisions/0046-wikilinks.md)                                | `[[Wikilinks]]`: regex mark decorations + Ctrl/Cmd-click (resolve by name/path, `#heading` jumps, `|alias`, create-missing) | Accepted |
| [0047](09_architecture_decisions/0047-llm-provider-abstraction.md)                 | LLM provider abstraction: base-owned `LlmClient` + per-call router, streaming/sessions/capabilities; opt-in cloud presets (amends the local-only principle and 0044's frozen-SDK rule) | Accepted |
| [0048](09_architecture_decisions/0048-chats-as-vault-notes.md)                     | Chats as vault notes: conversations under `chats/` with `drey-tool` blocks and full-history replay (supersedes 0012 for conversations; resolves bug-10(b)) | Accepted |
| [0049](09_architecture_decisions/0049-live-edit-mode.md)                           | Live edit mode: a composer toggle lets the model edit the open note directly via `doc_*` tools (diff hunks), immediate apply, advisory input lock — a per-turn opt-in exception to 0011 | Accepted |
| [0050](09_architecture_decisions/0050-ocr-via-vision-llm.md)                       | OCR via the connected vision LLM: a `plugins/ocr/` context-menu row on embedded images + image tabs, capability-gated (deviates from req-9's Tesseract idea) | Accepted |
| [0051](09_architecture_decisions/0051-multi-vault-registry.md)                     | Multi-vault registry: stable vault ids, `vaultId`-scoped IPC/docs/indexes/watcher, active-vault retention, `vaultId::path` doc keys (supersedes 0019's "no vault registry") | Accepted |
| [0052](09_architecture_decisions/0052-pdf-embeds-and-viewer.md)                    | PDF embeds + viewer tab: the built-in PDFium viewer (`plugins: true`) over `drey-asset://` iframes, name-preserving `attachments/` staging, `kind: 'pdf'` base doc kind | Accepted |
| [0054](09_architecture_decisions/0054-opening-files-from-the-os.md)                | Opening files from the OS: Explorer association for md/markdown/mdx/txt; vault files open normally, out-of-vault ones as pinned external tabs saved in place, behind a main-side read/write allowlist; pull-then-push delivery | Accepted |
| [0055](09_architecture_decisions/0055-semantic-vault-retrieval.md)                 | Semantic vault retrieval: the assistant's Vault chip retrieves top-k note sections (transformers.js WASM in a worker, JSON index per vault, system-prompt injection — sqlite-vec dropped) | Accepted |
| [0056](09_architecture_decisions/0056-spellcheck-language-autodetect.md)           | Spellcheck language auto-detect: `franc-min` detects each paragraph's language, words are checked per language group; fallback = configured dictionary; plus verdict memo + dictionary-eviction fixes | Accepted |
| [0057](09_architecture_decisions/0057-ui-refinement-icon-chrome-anthrazit-and-slash-capture.md) | UI refinement: sentence-case sans chrome with one shared icon button / segmented switch, the Anthrazit theme next to Drey, one text-and-tag query field, capture through the `/` menu (built-in Entry + templates with preview) replacing the "Add entry" drawer, formatting buttons in the meta bar, in-place file create/rename | Accepted |

Decisions not yet written up (relevant spec already fixes them, but the
ADR is deferred to the milestone that actually implements them, per
`CLAUDE.md`'s "fill in incrementally" guidance):

- Storage format: plain Markdown + YAML frontmatter, no database
  (relevant from milestone 2, vault/file access)
