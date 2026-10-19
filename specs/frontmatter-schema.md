# File & Frontmatter Schema

Frontmatter is **optional** and app-managed; a note is just Markdown, and the
tag system reads the body. The app-understood fields are `title`, `created`,
`updated` — plus `kind: chat` as the one document-class marker.

## Frontmatter (optional)
```yaml
---
title: 'Boat purchase'
created: '2026-08-01T09:14:27'
updated: '2026-09-05T14:32:00'
---
```
- All fields optional. A file with **no `---` fence** is written back
  byte-for-byte on save — the app never adds a header that wasn't there.
- With a fence, `note:save` sets `updated:` to the save time **only when
  the note already has that key**. Nothing is ever added — no `updated:`,
  no `created:` — and no other field is touched or removed, so a note
  whose frontmatter belongs to another tool (a mkdocs page) is saved as
  it is (milestone 65, ADR-0065).
- `created:` is a **date+time** stamp (`YYYY-MM-DDTHH:mm:ss`) written by
  whatever creates the file (the daily template, chat notes — since
  milestone 31); a save never adds it afterwards.
  Legacy date-only values (`'2026-08-01'`) in existing files remain valid,
  are displayed as-is, and are **never rewritten** to the new format.
- Always write dates as a **quoted string** — unquoted YAML dates break
  round-tripping.
- The editor folds frontmatter behind a collapsible pill (`▸ Frontmatter`);
  expanding it edits the raw YAML directly (no structured field editor).

## Body

- **Entries** are separated by `## HH:mm` or `## YYYY-MM-DD HH:mm` heading,
  optionally ` — Topic` plus a trailing `#tag` meta line (en dash or `--`
  accepted as separator). Both topic and meta line are optional. The layout
  is a template (`AppConfig.entry`, Settings → Entry format) with `{{time}}
  {{date}} {{datetime}} {{title}} {{tags}} {{content}}` placeholders.
- **Tags**: `#` + a letter, then letters/digits/`_`/`-`, lower-cased; nested
  with `/` (`#project/2024` — first segment must start with a letter, so
  timestamp headings never match). These are label hierarchies, not folders:
  searching `#project` also returns every `#project/*` section. Fenced and
  inline code spans are ignored. Grammar: `shared/tags/tags.ts`.
- **Tasks**: a GFM checkbox line and/or a line carrying the reserved
  `#task` marker (structural, never a tag; a bare `#task` line is done
  when it also carries `#task/done`). Task lines carry **no** machine
  tokens — the Tasks panel writes checkbox state back by re-resolving
  the line against fresh content at tick time and skipping ambiguous
  duplicates (never guessing a twin).
- **Task metadata** (req-37, Obsidian-Tasks compatible): a due date
  `📅 YYYY-MM-DD` and a priority glyph (`🔺` highest, `⏫` high,
  `🔽` low; absent = normal) may sit anywhere on a task line,
  whitespace-delimited. Both are parsed into the task record and kept
  out of the task text; malformed dates are ordinary content. The
  emojis stay human-legible annotations — unlike the rejected
  `#task/id:` scheme, they carry no opaque ids, and notes remain fully
  interoperable with Obsidian's Tasks plugin. Grammar:
  `plugins/tasks/shared/tasks.ts`.
- **Completion date** (milestone 57d, Obsidian-Tasks compatible): a
  completed task line carries `✅ YYYY-MM-DD`. Unlike the due date it is
  **written by the app**: every done toggle (Tasks panel row, the
  assistant's task block, the editor's `Ctrl+Enter` and Live Preview
  checkbox click) stamps today's date at the line's end — before a
  trailing `#task/done` — and reopening removes it. The token is parsed
  into the task record (`completed`) and kept out of the task text; it
  never marks a task done on its own (the box / `#task/done` decides). A
  box ticked by typing `[x]` by hand gets no date. Tasks completed
  before 57d carry none either: the "completed" view then falls back to
  the first `YYYY-MM-DD` in the note's file name (daily and dated
  meeting notes) and lists tasks with neither last. The meeting import's
  text form `done: YYYY-MM-DD` feeds the same field (read-only).

- **Markdown dialect** (milestone 72, [ADR-0070](../docs/09_architecture_decisions/0070-extended-markdown-dialect.md)):
  besides CommonMark/GFM the editor, every Markdown view and the PDF
  export understand bare-URL autolinks, sub/superscript, `==highlight==`,
  GitHub/Obsidian callouts (`> [!note]`; Obsidian's fold suffix —
  `> [!note]-` folded, `> [!note]+` open — folds in the editor on a click
  of the title, req-54; the fold is view state, never written back, and
  the exports render the callout open), `$…$` / `$$…$$` math (KaTeX),
  footnotes and curated `:emoji:` shortcodes. All of it is plain text in
  the file — the app stores nothing extra, and a tool that does not know
  the syntax still shows readable Markdown. Shared pure halves:
  `shared/markdown/`.

## Daily notes — `<dir>/<year>/<month>/YYYY-MM-DD.md`

One file per calendar day, nested by year/month. Created by quick-capture
from `templates/daily.md`, entries appended as `## HH:mm` headings.
Indexed for tag search. Path handling: `shared/daily.ts`.

The root folder `<dir>` is configurable in Settings → Daily notes
(`AppConfig.daily.dir`, default `daily/`; app config per ADR-0010, so one
folder shape across all vaults — never stored in the vault). Year/month
nesting and the `YYYY-MM-DD.md` file name are fixed (they are the grammar
the calendar matches against). Legacy flat files (`<dir>/YYYY-MM-DD.md`)
stay readable, but only inside the configured folder: notes left under a
previous folder are not migrated and no longer read.

## Chat notes — `chats/<year>/<month>/<date>-<slug>.md`

Standalone Markdown notes with `kind: chat` frontmatter (plus assistant
fields `provider`, `model`, optionally `session`, and `note` — the bound
document as `vaultId::relativePath`; absent for an unbound chat, and the
assistant panel follows the active document: switching to a note opens the
newest chat bound to it). Body: one `## User` /
`## Assistant` heading per turn, with tool calls persisted in
```drey-tool fenced blocks. A user turn asked about a selection
(milestone 74) starts with that selection as a Markdown blockquote
(capped at 2,000 characters), a blank line, then the question. `chats/` is created on demand and **is**
indexed. Chat notes are auto-saved by the engine and never trigger the
save-before-exit prompt.

## Other files the vault holds

- **Pasted/dropped images** go to an `attachments/` folder beside the
  note that references them (`shared/asset-name.ts`, ADR-0024), named
  `YYYY-MM-DD-HHmmss-<6 hex>.<ext>`; a dropped Office file is copied
  there as well and linked (Alt-drop links the original instead,
  ADR-0066). Created on demand — not an imposed structure.
- **Diagrams**: `.drawio.svg` / `.drawio.png` are ordinary images that
  carry the diagram, so a note embeds them like any picture; a plain
  `.drawio` opens in the diagram tab (ADR-0064).
- **PDFs and images** open in their own tabs; Word/Excel/PowerPoint files
  open in their own program and are never rendered (ADR-0066).
- **Not in the vault**: the local note history (ADR-0060) lives under the
  app's userData, never in the vault; app config and API keys likewise.
  In a Git vault the app runs the installed `git` and adds no files of its own.

## Ticket repositories (separate repo, own format)

A vault can be a dedicated **tickets repository** (ADR-0076): one
Markdown file per kanban ticket, phase = directory, transitions as git
moves, configured through `tickets/_meta/pipeline.md`. That format has
its own complete specification in [`ticket-schema.md`](ticket-schema.md);
only the YAML conventions above (quoted dates, LF) carry over — ticket
files are not notes, and none of the note frontmatter fields apply.

## Structural folders

- `daily/` — default root of the daily notes (`daily/<year>/<month>/…`;
  the root is configurable via `daily.dir`, the grammar lives in
  `shared/daily.ts`). Visible and tag-indexed like any user folder.
- `templates/` — Markdown templates for new notes; `{{date}}` `{{time}}`
  `{{datetime}}` `{{title}}` placeholders substituted at creation (unknown
  tokens untouched). `templates/daily.md` seeds new daily notes. Excluded
  from the tag index and tag search. `prompts/*.md` under the templates folder
  (`templates/prompts/` by default; it follows `templates.dir`) are the
  assistant's prompts: `# Titel`, `> Beschreibung`, then the prompt body
  (no placeholder substitution). The composer's picker inserts the body
  into the composer; the popover at a selection sends it as the question
  about the selection.
- `.drafts/` — untitled scratch buffers are committed here on exit as
  `.drafts/unnamed-N.md`. A dot-folder, hidden from tree and indexes.
  Only "Save as…" moves a draft out (deleting the original).
