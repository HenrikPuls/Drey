# Drey — Decisions: excluded and decided against

Ideas that were considered and **not** built, kept so they are not
re-litigated by accident. Open work lives in [`roadmap.md`](roadmap.md);
what shipped lives in [`changelog.md`](changelog.md). An item moves here
when the owner decides against it, with the date and the reason; reopening
one means moving it back to the roadmap with a new justification.

## Excluded ideas

- **Req-3/req-15** — `copilot-web` provider (Playwright + system Edge
  driving M365 Copilot's website). Prototyped, never merged
  (`feat/copilot-web-provider`, ADR-0040) — fragile PoC. Not part of the
  Req-29 remainder any more.
- **Req-17** — Jira integration: inline live ticket status, create
  tickets from the editor.
- **req-9** — OCR remainder (iPad): on-device handwriting recognition.
  Desktop half shipped (`ocr` plugin, vision-capable LLM, ADR-0050).
- **req-21** — dataview.js support.
- **req-10** — iPad/iPhone access via Tailscale.
- **req-11** — audio recording in interview mode (local Whisper; Win+H
  as likely first step).
- **Job Queue (generic, multi-consumer)** — background processes with
  status/progress, crash persistence, auto-pause on interactive use,
  meant to cover both re-indexing and export. No second consumer exists
  yet; a scoped version ships inside the Semantic Search milestone
  instead. Revisit as a standalone subsystem once export (or similar)
  needs it too.
- **Dedicated keyword search / FTS index** — free-text tag search already
  covers the common case; no evidence it's a bottleneck.
- **Daily tasks day view** — read-only multi-day aggregate; Tasks panel
  already covers collection + tick-back. Only useful if tasks end up
  scattered across many notes instead of daily notes.
- **Daily wrap-up** — automation convenience on existing data, no
  structural gap.
- **Interview mode** — templated adaptive interviews; real prompt-design
  effort, no confirmed usage pattern yet.
- **Colouring the file name by save state** (green new, orange changed) —
  raised in the feature-request list with the owner's own reservation;
  works against the distraction-free goal (2026-10-12, proposal pending
  the owner's confirmation).

## Won't do (decided against, kept for the record)

- **One composer switch per external source** (search, fetch, each MCP
  server) — decided with the owner for milestone 79 (2026-10-13): one
  Web chip covers everything that leaves the machine; which sources
  exist and whether they ask stays in Settings → Assistant tools. A
  tools menu in an already full tool row was ADR-0063's reason to defer
  the switch at all.
- **Web search only through an MCP server the user adds** — ADR-0063's
  first answer ("no bundled search provider: a vendor choice and a key
  the app would have to own"). Reversed in milestone 79 (2026-10-13):
  setting up a search server was the hurdle that kept the assistant
  offline. The app still owns no key — the user picks the provider and
  enters their own, or uses DuckDuckGo without one.

- **Pause / resume of large semantic rebuilds on interactive use** —
  considered for milestone 68 and dropped: an interactive ask never
  waits for a rebuild (the query embed queues behind at most one
  16-passage batch — tens of ms — then searches the current index),
  and the actual gap (a mid-rebuild index is incomplete) is not fixable
  by pausing. Recorded in ADR-0055's later-change section.
- **Task Center / stable task ids** (req-35) — implemented as milestone
  44 (`#task/id:<id>` mint-on-tick write-back) and reverted before
  release: the token is permanent noise in plain Markdown, adoption is
  inherently partial (editor checkboxes and external editors never
  mint), and the guarded mis-tick scenario (duplicate texts + shift +
  tick inside the unsaved window) is negligible for a single user. The
  Tasks panel's write-back resolves against fresh content at tick time
  and skips ambiguous duplicates instead of guessing — that is the
  whole fix ([ADR-0033](../docs/09_architecture_decisions/0033-tasks-panel-and-index.md),
  "considered and rejected").
- **req-24** — Editor: image lines should show only the image, no text.
  → Dropped (2026-09-12): Live Preview already renders image-only outside
  the caret; caret-in reveals the raw `![alt](path)` line by design
  (Req-1).
- **req-25** — Remove "unsaved"/"saved" status; always persist changes.
  → Decided against (2026-09-12): staying with manual save (Ctrl+S/Save
  button). Autosave design drafted and shelved. (The status itself stays;
  only its presentation is open, see the roadmap's "Editor chrome".)
- **req-26** — Frontmatter must update on save.
  → Dropped (2026-09-12): already implemented — `note:save` bumps
  `updated:` where the key exists; fence-less files stay byte-for-byte
  (`specs/frontmatter-schema.md`). Narrowed by milestone 65: a save never
  adds frontmatter.
- **req-41 alternatives** — two other homes for the formatting commands.
  → Decided against (2026-10-13). A *selection bubble* over marked text
  pops up on every selection, hides the line above, and block commands
  (table, callout, math block) have no selection to hang on. A *toolbar
  row of its own* under the meta bar costs a line of height for good and
  leaves the meta bar nearly empty. Built instead: the strip as the head
  of the right-click menu, pinnable into the meta bar.
- **Assistant tool rework — alternatives** (ADR-0071).
  → Decided against (2026-10-13). *New tools for the assistant only,
  the MCP server unchanged*: no break for connected programs, but two
  families of read and write logic for good. *Unified diffs as the edit
  format*: line offsets and hunk headers are what models get wrong; the
  exact search-and-replace that must match once stays. *A JSON-Schema
  library for tool arguments*: the slips are shallow, and the messages
  have to be written for the model. *A higher round cap instead of a
  closing round*: it only moves the point where the turn is lost.
  *A copy of the open buffers in main* (milestone 78): two owners of
  the same text; main asks the renderer at the moment of the call
  instead. *Keeping the `doc_*` live-edit tools*: a second edit tool for
  the same operation.
