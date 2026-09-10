# 41. Drag an `.ics` / `.msg` onto the editor → a `#mtg/<slug>`-tagged meeting section

## Status

Accepted. Built at the project owner's request. Net-new scope beyond the
Phase-1 MVP (nothing calendar-ingest was on the roadmap; the "Calendar"
references there are only the mini-calendar dock panel).

## Context

Dragging a calendar invite from Outlook (or a saved `.ics` / `.msg` from
the file system) onto a note did nothing useful — `.ics` / `.msg` fell
through the `imagePaste` drop handler's final branch and were silently
swallowed. The owner wants the invite decoded into a readable **meeting
section** inserted at the cursor: title, date/time, participants,
invitation body, attachment names, a notes placeholder — auto-tagged
`#mtg/<kebab-case-title>` so it is picked up by the tag section index and
found via tag search.

Constraints from the codebase:

- No Node in the renderer; all file decoding crosses the `contextBridge`.
- Electron 44 removed `File.path`, and `webUtils.getPathForFile` is not
  bridged, so the renderer sees dropped-file **bytes**, not a path.
- `.msg` is a binary OLE2 / CFBF container — a Node library is unavoidable.
- Feature-module convention (ADR-0016): new modules get a thin `index.ts`
  barrel and an `eslint.config.mjs` entry.

## Decision

**Decode in the main process; return finished Markdown. One IPC call for
both formats.**

- **`meeting:decode(bytes, filename) → string`** — the renderer sends the
  dropped file's bytes; main sniffs the format (extension, then
  `BEGIN:VCALENDAR` / the OLE2 magic `D0 CF 11 E0`), parses, loads
  `templates/meeting.md`, renders it, and returns the ready-to-insert
  section. No file is written. Same shape as `daily:build-content`
  (`DailyNoteManager.noteContentFor`): compute-only, returns text, no
  index / watcher impact. `.ics` is text but still goes through main so
  there is exactly one decoder, one template loader, one set of fixtures.
- **`meeting:import() → string | null`** — a native file picker in main
  for the **File → Import meeting …** menu row, the guaranteed path for
  when an Outlook *calendar* drag on Windows delivers a promised / virtual
  file with no entry in `dataTransfer.files`. Same decoder, same renderer
  insertion (`EditorService.requestInsertText`).

**Three feature modules:**

- **`shared/meeting/`** — pure, dependency-free: the normalised
  `ParsedMeeting` shape, `slugifyMeetingTitle`, date/time range
  formatting, a tiny `{{#if}}` / `{{#each}}` / `{{key}}` template evaluator
  (`renderTemplate`), the meeting-section renderer, and
  `STARTER_MEETING_TEMPLATE`.
- **`electron/meeting/`** — the only holder of `ical.js` and
  `@kenjiuno/msgreader`. `MeetingImporter` orchestrates: sniff → parse
  (`ics-decode` / `msg-decode`) → load-or-scaffold `templates/meeting.md`
  → render. `msg-decode` falls back to the ics path when an appointment
  `.msg` has no event fields but carries an `.ics` attachment (Outlook
  forwards invites this way).
- **`src/app/meeting/`** — `MeetingService`, a thin bridge: `decodeToMarkdown`
  (drop path) and `importIntoNote` (menu fallback).

**Dependencies** (`electron/` only — no Node in the renderer bundle):

- **`ical.js`** (MPL-2.0). Handles RFC 5545 line-unfolding and
  `KEY;PARAMS:VALUE` parsing, and — the deciding factor — resolves the
  `VTIMEZONE` blocks Outlook embeds, so `DTSTART` / `DTEND` convert to the
  machine's local wall time with no IANA timezone database shipped.
  Hand-rolling the timezone maths is the error-prone part; the rest of RFC
  5545 is small but not the risk. `ical.js` 2.x is ESM-only with a
  namespace default export that Node16 CommonJS interop cannot surface
  cleanly, so `ics-decode` loads it with a dynamic `import()` and types it
  against a small local facade (the ~8 members it touches).
- **`@kenjiuno/msgreader`** (Apache-2.0). Pure-JS OLE2 / CFBF reader, no
  native module. Both licenses are GPL-3.0-only compatible; both are
  captured in `src/assets/licenses.json` via `npm run licenses:generate`.

**Drop integration** — a new branch in `src/app/editor/image-paste.ts`
`drop()`, after the template branch and before the image-file branch: a
`.ics` / `.msg` file → `event.preventDefault()` → read bytes →
`config.decodeMeeting(bytes, name)` → insert the returned block on its own
padded lines at the drop coordinate (`sectionInsert`). No
`![](uploading:…)` placeholder — decode is sub-second and an image glyph
would be wrong. Errors route to `config.onError` (the editor's error
notice). `wantsDrop` already covers `'Files'`, so `dragover` /
`preventDefault` were unchanged; the `DropGuardService` window guard and
`PaneDropService` were untouched (a meeting drop must land on the editor
text, same as image / text drops today).

**The meeting section** — one `##` section, peer of the `## HH:mm` entry
headings. `#mtg/<slug>` sits on its own line **directly under the `##`
title heading** (not at the bottom) so a tag search for `#mtg/…` shows the
meeting name, not the last sub-heading. `#mtg/<slug>` already parses as one
hierarchical tag under the existing grammar (`shared/tags/tags.ts`) — no
grammar change, and `#mtg` is a **naming convention**, not a reserved
namespace (`#task` stays the only `RESERVED` marker; there is no
tag-prefix registry). Only the *tag* is slugified (umlauts → `ae/oe/ue/ss`,
other accents via NFKD, reply/forward prefixes stripped, capped ~60 chars);
the heading keeps the human title verbatim.

**`templates/meeting.md`** is the customization surface. The shipped
default carries **English** labels (the language convention applies to
code artifacts); the owner replaces the file with their own version
(German, emoji, other layout) — that copy is vault data, out of scope for
the convention. The template uses the mini-evaluator's `{{#if}}` /
`{{#each}}` so optional sections (location, organizer, attendees, join
link, invitation body, attachments) vanish cleanly when absent. Scaffolded
from `STARTER_MEETING_TEMPLATE` on first use, exactly like
`templates/daily.md`.

## Behavioural choices

- **Multi-`VEVENT` `.ics`** — first non-recurring event only, silent.
- **Recurring instance** — one `#mtg/<title-slug>` shared across
  instances; the date is in the body, so no date-suffixed slug.
- **Blank subject** — heading `Untitled meeting`, slug `meeting`.
- **A `.msg` that is a plain e-mail** (no appointment fields, no `.ics`
  attachment) — rejected with "The invite has no event in it."
- **`.msg` body** — plain text only; HTML / RTF bodies are not converted.
- **All-day `.ics`** — RFC 5545's exclusive `DTEND` is stepped back to the
  last included day. `.msg` has no exposed all-day flag, so a
  local-midnight-to-local-midnight span of ≥ 1 day is treated as all-day.
- **Zero config** beyond the template file — no `AppConfig` slice, no
  Settings UI.
- **The invite file is not archived** into `attachments/`. The section
  captures the useful content as readable Markdown; keeping the binary
  adds clutter with no reader payoff. Could be revisited behind a setting.

## Consequences

- A dependency on `ical.js` + `@kenjiuno/msgreader`, isolated to
  `electron/meeting/`. `ical.js` is loaded via dynamic `import()` from a
  CommonJS main process — fine at runtime, but it means `ics-decode` is
  async and typed against a hand-written facade rather than the package's
  own d.ts.
- **Windows drag source matters (confirmed).** Dragging an appointment
  straight out of **classic Outlook** produces a real `.ics` `File` and
  the drop works. **New Outlook / OWA** hands over a promised / virtual
  file (shell `FileGroupDescriptor`, no `File` in `dataTransfer.files`),
  so the drop branch never fires — the user must save the invite as
  `.ics` first, or use **File → Import meeting …**. A saved `.ics` /
  `.msg` dragged from Explorer always works. In practice this makes the
  drag path less useful than hoped and the Import menu the primary entry
  point; the feature is kept because saved-file drops and Import both work
  and the decode / render half is the valuable part.
- `image-paste.ts` gains one more `DataTransfer` branch; the config object
  gains `decodeMeeting?`. When it is not wired (a hypothetical web build)
  a `.ics` / `.msg` drop is swallowed as before.
- The tag vocabulary can accumulate many `#mtg/*` entries over time — the
  same as any hierarchical tag namespace; `#mtg` matches all of them in
  search.

## Testing

- Unit (`ng test`, `src/app/meeting/*.spec.ts` testing `shared/meeting`):
  `slugifyMeetingTitle`, `meetingWhen` ranges, the `renderTemplate`
  evaluator, `renderMeetingSection` (full / sparse / all-day, tag
  cross-checked with the real `extractInlineTags`), `MeetingService`.
- `image-paste.spec.ts` gains a `meeting drop` block (decode called with
  the right bytes / filename, block inserted, decode failure → `onError`,
  no-op when `decodeMeeting` is unset, `.msg` recognised, image drop
  unregressed).
- `e2e/meeting-drag.spec.ts` — drop a real `.ics` onto the built app,
  assert the section + `#mtg/<slug>` + join link on disk, and a malformed
  `.ics` → error notice, nothing written. (Shares the `openNote` helper
  with `e2e/image-drag.spec.ts`.)
- Main-process decode / timezone conversion / template scaffolding were
  validated with an ad-hoc Node harness against the compiled
  `dist-electron/electron/meeting/`. A dedicated Node test runner for
  `electron/**` was considered and deferred.
