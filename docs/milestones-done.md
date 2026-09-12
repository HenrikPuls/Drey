# Completed milestones (archive)

Moved out of CLAUDE.md's "Build Order (Milestones)" on 2026-09-12 so the
project-context file only carries active, session-relevant rules. The
entries below are verbatim as they were written when each milestone
shipped; the finer-grained record lives in the ADRs
(`docs/09_architecture_decisions/`) and the arc42 docs. CLAUDE.md tracks
only the next milestone and the last completed one.

Milestone 20 (editor panes in the docks) shipped on 2026-09-12 and is
archived below; it was briefly tracked in CLAUDE.md as the next
milestone before being built.

1. Electron shell + Angular scaffold, IPC bridge, docs/ skeleton (including the 09_architecture_decisions/ subfolder)
2. Vault selection + file listing
3. Editor: CodeMirror 6 with decoration-based Live Preview + source mode, `⋯` mode menu (ADR-0008/0009)
4. Quick-capture (global hotkey, popup window)
5. Implement multi tab support (x to close tab, only prompts to safe if program is closed not by switching editors )
6. Tag parsing, autocomplete, registry index, deterministic routing
7. LM Studio client + task/note classification (Prompt 1)
8. Inbox + batch tag suggestion (Prompt 2)
9. Keyword search
10. Master document summary — now the built-in "Update summary" Action (see 10)
11. Settings screen (LLM connection + Actions engine) + one shared
    confirmation flow + chat Input/Ask toggle. Built in a single pass on
    top of milestone 6, pulling forward the LM Studio client (6), batch
    tag suggestion / Prompt 2 as the "Autotagging" built-in (7), and the
    master-document summary (9). ADR-0010 (settings storage), ADR-0011
    (unified confirmation flow).
12. **Tag rebuild** — milestones 5, 7, 8 and 9 above are **superseded**
    ([ADR-0017](09_architecture_decisions/0017-tags-as-labels-and-section-index.md)):
    free `#tag`s, a vocabulary + inverted section index, a sidebar tag
    search (tags AND + free text) with open-at-line and Markdown Export,
    and the vocabulary-based Autotag button. Also: feature modules
    (ADR-0016), manual refresh instead of a watcher (ADR-0018), file
    delete, nested daily-note paths, scratch tabs + Save-as.
13. Prompt sweep to English + docs/specs/ADR reconciliation.
14. **v3 visual system + dock layout** — the `handoff/` design system
    ([ADR-0019](09_architecture_decisions/0019-movable-dock-panels-and-layout-state.md)):
    central design tokens, a frameless titlebar with an HTML menu bar,
    two docks of movable/resizable/collapsible panels (calendar, files,
    search, open windows, assistant) replacing `SidebarComponent`, a
    status bar, line numbers in the editor, and the tab/meta-bar + drawer
    reskin. Built in five steps (tokens → shell → dock mechanics → the
    five panels → editor chrome), pausing after each.
15. **MCP + shell follow-ups** — built in one pass at the project owner's
    request: the vault MCP server + assistant vault tool use
    ([ADR-0021](09_architecture_decisions/0021-mcp-vault-server.md)),
    a **bottom dock** with "Add entry" as a panel (ADR-0019 later change),
    the assistant carrying its thread on Ask + an insert-into-note arrow,
    the split-diff confirmation preview (ADR-0011 update), and the
    content-height calendar panel.
16. **Named themes** — a theme picker in Settings → Appearance
    ([ADR-0035](09_architecture_decisions/0035-named-ui-themes.md)): the
    **Drey** built-in look plus the published CodeMirror 6 themes
    (`@uiw/codemirror-themes-all`), the editor swapping its CM theme in a
    compartment and the app shell re-tinting from a per-theme seed
    (`src/styles.css` `:root[data-theme]`, `ThemeService`).
17. **Widget registry + View visibility** — the dock panels become a
    data-driven `src/app/widgets/` registry with a typed `WidgetContext`
    read-facade (active document, file tree, tag/task queries); the View
    menu hides/shows a whole widget rather than only collapsing it
    ([ADR-0034](09_architecture_decisions/0034-internal-widget-model.md);
    refines ADR-0016, amends ADR-0019). Internal structure only — no
    runtime/third-party plugin loading.
18. **Settings → Widgets enable/disable** — a `widgets` config slice + a
    Settings category to turn a widget off entirely (ADR-0034).
19. **Editor polish + split-view panes** — five owner-requested fixes/
    features built in one pass: the frontmatter-fold block widget's height
    measurement (`margin` → `padding`) and its `inline-flex` baseline
    leading (`vertical-align: top`), both of which drifted the gutter and
    click hit-testing below the fold; per-file syntax highlighting for
    non-Markdown files via a language `Compartment` on `MarkdownSurface`,
    forcing source mode and dropping the Markdown-only chrome
    ([ADR-0036](09_architecture_decisions/0036-code-file-editor-mode.md));
    the Tasks panel's vault-scope rows/headers sized to content instead of
    clipping; drag-to-reorder tabs in the tab bar; and split-view editor
    panes — an arbitrary row/column split tree (`PaneService`,
    `PaneLayout`/`PaneLeaf`), `EditorService` reframed as a facade over the
    *focused* pane so every other "current document" consumer needed no
    change ([ADR-0037](09_architecture_decisions/0037-split-view-editor-panes.md)).
    Docking a pane into the left/right/bottom dock is its own follow-up
    (ADR-0037's Phase 2), not built here.
19a. **Gutter alignment + split-view entry points** — a follow-up after the
    milestone-19 gutter fixes proved insufficient: the real cause was the
    line-number element inheriting the unitless `1.72` line-height from
    `.cm-scroller` (re-multiplied against its 10.5px font) plus an
    un-hidden markdown fold-arrow column (base theme `.cm-gutter { display:
    flex !important }` beat a plain `display:none`). Fixed in `gutterTheme`
    (explicit px `line-height` + `flex-start` top-alignment; `display: none
    !important` on `.cm-foldGutter`). Same pass: `pane.splitRight/splitDown/
    focusNext/focusPrev` `KeybindingService` commands + View-menu rows
    (the split tree already existed, only the tab context menu reached it),
    and `Editor` pulls the caret into a pane on focus-gain.
19b. **Drag-and-drop chrome** ([ADR-0039](09_architecture_decisions/0039-drag-and-drop-chrome.md))
    — the tab drag was a fake drag (committed live on every mousemove). A
    shared `src/app/dnd/` overlay (kills hover/selection leak, owns the
    cursor) + ghost, a new `TabDragService` owning the gesture (deferred
    commit, drop-line, `no-drop` on invalid targets, tab-strip *or*
    pane-body drop, ESC / blur cancel, the `data-drey-gesture` watchdog
    marker), and `DockService`'s header drag moved onto the same overlay.
19c. **Editor fold gutter + drop-to-open** — two owner-flagged follow-ups.
    (1) Milestone 19a hid `.cm-foldGutter` outright; the Obsidian-style
    collapsible headings that killed are back — the fold column is now
    always-on in `editorStructure` (chevron styled + hover-revealed, same
    vertical metrics as the line-number element so no drift returns), and
    only the line-number column follows the "Lines" toggle
    (`gutterTheme`). (2) A vault file dropped on a pane but not on
    `.cm-content` opens as a tab there — `PaneDropService`, from
    `PaneLeaf`'s `dragover`/`drop` (ADR-0027 / ADR-0028 amendment).
20. **Editor panes in the docks** ([ADR-0038](09_architecture_decisions/0038-editor-panes-in-docks.md),
    ADR-0037's Phase 2) — a `PaneService` *region* model: each dock
    (left/right/bottom) hosts at most one pane in an **editor band**
    above its widget stack (32px header with the active tab's name, its
    own splitter; the widget registry and `DockState` untouched). Entry
    points: the tab context menu ("Move to left/right/bottom dock",
    "Move back to editor area") and dragging the band header — the dock
    drag payload is now a widget *or* an editor pane, and the centre
    column became an editor-only drop target. An occupied dock's occupant
    returns to the centre; splits refuse on docked panes; a band whose
    last tab closes dissolves. Docked editors ride the session snapshot's
    optional `dock` field (ADR-0043's `drey.session`, superseding the
    ADR's original separate-key plan) and survive a restart with their
    tabs; `View → Reset layout` undocks them too.
21. **The runtime plugin program**
    ([ADR-0044](09_architecture_decisions/0044-runtime-plugin-system.md)) —
    the modular monolith became a base application plus runtime-loadable,
    in-process plugins. SDK freeze → hosts + `plugin://` + sample plugin →
    base seams (editor extensions, drop decoders, save/vault hooks,
    section search) → the six feature modules converted one by one
    (templates, meeting, tags, tasks, assistant+Actions, browser — the
    browser's doc-kind registry shipped first, shippable alone) → cleanup
    + docs → packaging (plugins verified working from inside `app.asar`,
    no `asarUnpack`). `eslint.config.mjs` shrank to the base modules and
    gained the plugin authoring rules (no `@codemirror/*` / `@angular/*`
    runtime imports, no Node in plugin renderers); Settings → "Panels &
    plugins" manages both panels and plugins.
24. **Assistant composer rework** — the Claude-Code-style composer: a
    global `::-webkit-scrollbar-corner` fix (the white square in any
    scroll container's lower right — styling any scrollbar part switches
    Chromium to custom painting, and the unstyled corner rendered solid
    white), a **model row** on the panel that edits the one global
    `llm.model` through the new `api.llm.listModels()` facade (provider
    label + listing capability + best-effort list; hand-entry always
    available, `PLUGIN_API_VERSION` minor → 1), **context chips** (the
    open note attached by default and deselectable; extra vault files via
    `@`-completion or the "+" picker, read at send time as live
    buffer/vault content, capped per file), and an **auto-growing
    composer** (content height up to a cap, then it scrolls inside; the
    drag divider and its persisted height pref are gone). The ask payload
    became `{ question, note | null, extraFiles, history }`
    (`plugins/assistant/shared/ask.ts` — note `null` turns the turn
    answer-only via a second system prompt); the templates picker's modal
    selector (descendant where only a compound could match) fixed in
    passing.
