# 0073 — Configurable shortcuts

## Status

Accepted (2026-10-14, milestone 75). Extends
[ADR-0067](0067-in-app-help-documents.md) (the generated shortcuts page now
shows the user's chords) and [ADR-0010](0010-app-settings-storage.md)
(a new base config slice).

## Context

Every command in `KeybindingService` carries its chord in code (19 base
commands in `src/app/app.ts`, five from plugins). Nothing could change
one, and the quick-capture hotkey was a constant in `electron/main.ts`
whose only failure report — another program already holds the combo —
was a console line. The menus printed their hints as literal strings, so
even a code change to a chord had to be repeated by hand in four places.

Decided with the owner (2026-10-13, 2026-10-14): one user-defined binding
per command, stored in the app config (never in the vault); rebindable
are every command in the registry, core and plugin, and the quick-capture
hotkey; the editor's own keys stay fixed. A chord is recorded by pressing
it; a chord must carry Ctrl or Alt, or be a function key.

## Decision

**A base config slice, `keybindings`** (`shared/config/schema.ts`):

- `overrides: Record<commandId, chord | null>` — a chord replaces the
  command's default, `null` leaves it without a shortcut, a missing id
  keeps the default. Keyed by command id, so a plugin command's override
  applies whenever the plugin registers it, and survives the plugin being
  disabled and enabled again.
- `capture: chord | null` — the system-wide quick-capture hotkey
  (default `Mod+Alt+N`), `null` = none.

It is base config, not plugin config (ADR-0044 / A6): the keybinding
registry is part of the base application.

**The chord grammar is shared** (`shared/keybindings.ts`): a canonical
spelling (`Mod+Alt+Shift+K`), the validation (needs Ctrl/Alt or a
function key; a fixed list of chords the editor and Electron need is
refused — undo/redo, clipboard, select all, find, Ctrl Enter, zoom,
Ctrl Space, Alt F4, the editor's line moves) and the conversion to an
Electron accelerator. `normalizeAppConfig` drops a stored chord that is
no longer valid, so a bad hand edit falls back to the default.

**`KeybindingService` resolves every chord through the overrides.**
`register()` keeps the command's own chord as its default; the effective
chord is the override if there is one. The chord index is rebuilt from
the commands on every change, so re-registering a command without a
chord (a disabled plugin's inert stand-in) also drops its old chord — the
index previously kept it. `all()` reports the effective chord, so the
palette and the generated shortcuts page follow without change; a
`hint(id)` signal-backed lookup feeds every place that prints a shortcut
(menus, the tab and editor context menus, the meta bar, the formatting
strip).

**Settings → Keyboard shortcuts** (core category): one row per command
plus the quick-capture hotkey, each with its chord, *Change* (press the
new chord; Esc cancels; the registry's listener is paused meanwhile),
*Remove* and *Reset*. A chord another command holds is shown with its
holder and a *Replace* that leaves the other command without a
shortcut. The fixed keys (the editor's, the mouse side buttons) are
listed below, read-only.

**Main re-registers the quick-capture hotkey on `config:set`**
(`electron/capture-hotkey.ts`) and keeps whether the registration
succeeded; the Settings page shows "In use by another program" from
`shortcuts:capture-status`.

## Consequences

- A rebinding reaches the menus, the palette, the shortcuts page and the
  tooltips at once; none of them holds a chord of its own any more.
- The menu hints of fixed editor keys (Undo, Find in note, Select line …)
  stay literal — those keys are not in the registry.
- Two commands can still share a chord when both come from code defaults
  (a plugin choosing a base chord); the override-bound one wins, then the
  first registered. The Settings page shows such a pair as a conflict.
- Keyboard layouts: chords are matched on `KeyboardEvent.key`, as before.
  A chord recorded on one layout may need re-recording on another.
- No SDK change: plugin commands already go through `register()`.
