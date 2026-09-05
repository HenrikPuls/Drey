# 2. Quick-capture opens the day's daily note in the editor (no popup)

## Status
Accepted

## Context
`specs/roadmap.md` (Phase 1) specifies quick-capture as a **global
hotkey + popup window** with its own text input. A first implementation
built exactly that: a frameless `BrowserWindow` loading the renderer with
`?window=capture`, submitting captured text to `inbox.md`.

The project owner rejected that model in review: a small popup with its
own input is a second, constrained editing surface; captures should land
in the real editor where all the normal affordances (source/rendered
toggle, full-height CodeMirror, later spellcheck/autocomplete) are
already available. They also asked for a per-day note as the capture
target and a vault template folder that controls how new notes look.

## Decision
The hotkey (`Ctrl/Cmd+Alt+N`, still global) does **not** open a window of
its own. It:

1. brings the existing main window forward (`show()` + `focus()`,
   `restore()` if minimized);
2. has the main process ensure today's daily note exists —
   `daily/YYYY-MM-DD.md`, created from `templates/daily.md` with
   `{{date}}` / `{{time}}` / `{{datetime}}` / `{{title}}` substituted;
3. pushes that vault-relative path to the renderer over a new
   main→renderer channel `daily:open`;
4. the renderer opens it in the editor and starts a fresh `## HH:mm`
   entry heading at the end of the buffer (skipped if the buffer already
   ends with an empty one), leaving it dirty for a normal Ctrl+S save.

`templates/daily.md` is scaffolded with a starter on first use, so "change
how daily notes look" is just editing that file. The template mechanism
(`electron/daily-note.ts`, `applyPlaceholders`) is deliberately generic —
milestone 5 reuses it when tag-routing creates master/notiz files.

Rejected alternatives: the popup window (above — a worse editing surface,
and a whole second renderer entry point to maintain); appending capture
text to `inbox.md` (kept as the milestone-7 destination for *untagged*
review items, not the primary capture path).

## Consequences
- Divergence from `specs/roadmap.md` is now real and should be reflected
  there. "Daily note" as a per-day file and a Phase-1 `templates/` folder
  are both new vs. the specs (the roadmap only had a read-only day view
  built from timestamp scanning; templates otherwise appear in Phase 4).
- No second window, no `?window=` bootstrap branch, no popup lifecycle to
  manage. `index.html` has a single root element again.
- The main process now writes files the user didn't explicitly create
  (`daily/…`, `templates/daily.md`) — the first hotkey press in a fresh
  vault materialises three paths. Acceptable and visible; flagged so it
  isn't a surprise.
- The renderer needs local time formatting too (the `## HH:mm` heading),
  so `formatTimestamp` & friends moved from `electron/` to
  `shared/timestamp.ts` (pure, no Node deps, compiled into both
  contexts).
- The editor gains one narrow external-command path: `EditorService`
  exposes a `newEntryRequest` counter + a pure `newDailyEntryEdit()`
  helper; `Editor` applies the computed edit to CodeMirror. This is the
  first time anything outside the `Editor` component mutates the buffer.
- If a vault isn't selected, the hotkey still raises the window (so the
  "no vault" sidebar state is the feedback) and logs; a proper toast is
  deferred.
