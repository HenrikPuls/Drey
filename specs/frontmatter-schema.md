# File & Frontmatter Schema

Frontmatter is **optional** and app-managed; a note is just Markdown, and the
tag system reads the body. The app-understood fields are `title`, `created`,
`updated` — plus `kind: chat` as the one document-class marker.

## Frontmatter (optional)
```yaml
---
title: 'Boat purchase'
created: '2026-08-01'
updated: '2026-09-05T14:32:00'
---
```
- All fields optional. A file with **no `---` fence** is written back
  byte-for-byte on save — the app never adds a header that wasn't there.
- With a fence, `note:save` bumps `updated:` to the save time and fills a
  missing `created:`; no other field is touched, added or removed.
- Always write dates as a **quoted string** — unquoted YAML dates break
  round-tripping.
- The editor folds frontmatter behind a collapsible pill (`▸ Frontmatter`);
  expanding it edits the raw YAML directly (no structured field editor).

## Body

- **Entries** are separated by `## HH:mm` or `## YYYY-MM-DD HH:mm` heading,
  optionally ` — Topic` plus a trailing `#tag` meta line (en dash or `--`
  accepted as separator). Both topic and meta line are optional. The layout
  is a template (`AppConfig.entry`, Settings → Add entry) with `{{time}}
  {{date}} {{datetime}} {{title}} {{tags}} {{content}}` placeholders.
- **Tags**: `#` + a letter, then letters/digits/`_`/`-`, lower-cased; nested
  with `/` (`#project/2024` — first segment must start with a letter, so
  timestamp headings never match). These are label hierarchies, not folders:
  searching `#project` also returns every `#project/*` section. Fenced and
  inline code spans are ignored. Grammar: `shared/tags/tags.ts`.
- **Tasks**: `#task` with a mandatory `id:` (so checkbox clicks can be
  written back unambiguously); optional `due:` / `prio:`; `done:` only once
  checked off. `#task` is a reserved structural marker, never a tag.

## Daily notes — `daily/<year>/<month>/YYYY-MM-DD.md`

One file per calendar day, nested by year/month. Created by quick-capture
from `templates/daily.md`, entries appended as `## HH:mm` headings.
Indexed for tag search. Path handling: `shared/daily.ts`.

## Chat notes — `chats/<year>/<month>/<date>-<slug>.md`

Standalone Markdown notes with `kind: chat` frontmatter (plus assistant
fields `provider`, `model`, optionally `session`). Body: one `## User` /
`## Assistant` heading per turn, with tool calls persisted in
```drey-tool fenced blocks. `chats/` is created on demand and **is**
indexed. Chat notes are auto-saved by the engine and never trigger the
save-before-exit prompt.

## Structural folders

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
