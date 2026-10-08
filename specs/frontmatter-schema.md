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
- With a fence, `note:save` bumps `updated:` to the save time and fills a
  missing `created:`; no other field is touched, added or removed.
- `created:` is a **date+time** stamp (`YYYY-MM-DDTHH:mm:ss`) on newly
  created files (notes, daily notes, chat notes — since milestone 31).
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
```drey-tool fenced blocks. `chats/` is created on demand and **is**
indexed. Chat notes are auto-saved by the engine and never trigger the
save-before-exit prompt.

## Structural folders

- `daily/` — default root of the daily notes (`daily/<year>/<month>/…`;
  the root is configurable via `daily.dir`, the grammar lives in
  `shared/daily.ts`). Visible and tag-indexed like any user folder.
- `templates/` — Markdown templates for new notes; `{{date}}` `{{time}}`
  `{{datetime}}` `{{title}}` placeholders substituted at creation (unknown
  tokens untouched). `templates/daily.md` seeds new daily notes. Excluded
  from the tag index and tag search. `templates/prompts/*.md` are the
  assistant panel's prompt picker entries: `# Titel`, `> Beschreibung`,
  then the prompt body (no placeholder substitution — the picker inserts
  the body into the composer).
- `.drafts/` — untitled scratch buffers are committed here on exit as
  `.drafts/unnamed-N.md`. A dot-folder, hidden from tree and indexes.
  Only "Save as…" moves a draft out (deleting the original).
