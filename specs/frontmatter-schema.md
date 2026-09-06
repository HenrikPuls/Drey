# Frontmatter Schema

## Base fields (every file with frontmatter, except the inbox)

```yaml
---
type: master            # master | notiz | interview-template — see below
title: "Boat purchase"
tags: ["sailing", "purchase-process"]   # tags[0] = primary tag, determines physical location
aliases: []             # optional, alternative names for autocomplete matching
created: "2026-08-01"
updated: "2026-09-05T14:32:00"
---
```

- `type`: `master` (one document per tag, classifier context + glossary
  content), `notiz` (an ordinary content file inside a topic folder), or
  `interview-template` (Phase 4). Determines which extra fields are valid
  (see below) and whether the file shows up as the main entry in the tag overview.
- `tags`: an array, not optional (empty is allowed for brand-new/unclear
  files still sitting in the inbox). **`tags[0]` is the primary tag** — it
  decides which folder the file lives in. Order of the remaining tags
  doesn't matter, they're pure search metadata.
- `aliases`: for tag autocomplete — typing `#boat` should still suggest
  `sailing` if `boat` is registered as an alias. Same idea as with person
  names, just for topics.
- `created` / `updated`: `updated` is bumped automatically on every save
  (editor autosave AND external change via the file watcher) — otherwise
  the day view, which relies on timestamps, goes stale.
  - **Implemented (milestone 6a):** the bump runs in the main-process
    `note:save` pipeline on an explicit save, not the (not-yet-built) file
    watcher; `created` is filled with today's date if the file has none.
    When the watcher lands it should call the same pipeline for external
    changes. See `docs/09_architecture_decisions/0007-on-save-tag-pipeline.md`.
- ⚠️ Technical note: always write dates as a **quoted string**
  (`"2026-09-05"`), never unquoted. Some YAML parsers auto-convert unquoted
  dates into Date objects, which can cause inconsistencies if a script in a
  different language ever touches these files too.

### Editor display

The editor keeps the frontmatter in the file but **folds it behind a pill**
(`▸ Frontmatter · N fields`) by default, in both Live Preview and source
mode — a note opens as prose, not metadata. Clicking the pill expands the
block to dim, editable raw YAML with a chevron to fold it back; the fold
state is remembered per open tab. There is no structured field editor yet;
expanding edits the YAML directly. See
`docs/09_architecture_decisions/0009-live-preview-decorations.md`.

## Type-specific fields

### `type: master` — one document per tag, combines folder context + glossary

```yaml
art: person              # thema | person | team | projekt | begriff
description: "Short context the classifier uses for assignment"
verweis: null            # optional, path to another file (e.g. a team → its main contact's master doc)
```

- `art` says what kind of thing this tag represents — replaces the earlier
  topic/person split and the three separate glossary categories.
- `description` is required, short (one sentence) — it's the classifier
  context. Free-form context ("anything goes here") belongs in the body,
  not the frontmatter.
- If the file lives at the vault root, it's the only document for this tag.
  Once the topic grows, it becomes the folder's index
  (`<folder>/_index.md`), further notes in the same folder inherit the
  primary tag automatically but don't need `art`/`description` themselves —
  just `title`, `tags`, `created`/`updated` from the base schema.

### `type: notiz` — an ordinary content file inside a topic folder
No extra field needed, just the base fields. Differs from a master document
in that it carries no `art`/`description` and is therefore not pulled in as
classifier context for new-folder proposals.

### Daily notes — `daily/YYYY-MM-DD.md`

One `type: notiz` file per calendar day, living in the structural `daily/`
folder (not a topic folder). Created by the quick-capture hotkey from
`templates/daily.md`; entries are appended as `## HH:mm` timestamp
headings per the body conventions below. `daily/` is excluded from tag
routing and the tag overview.

## Body structure inside a master document

Master documents (`type: master`) are organized into three fixed sections:

```markdown
## Summary
*(auto-generated, as of <timestamp>)*
...

## Context
...

## History
### 2026-09-05 14:32
...
```

- **Summary**: the only section that gets auto-overwritten — triggered
  manually by the built-in **"Update summary"** action (from the editor's
  `⋯` menu; no silent background regeneration). Weighting: last 7 days (or
  last N entries, for irregular activity) go in in full, older material
  gets compressed to a half-sentence or dropped. The line
  `*(auto-generated, as of <timestamp>)*` is rewritten under the heading
  on each run. See
  `docs/09_architecture_decisions/0011-unified-confirmation-flow.md`.
- **Context**: a free area, untouched by any automation — this is where
  "anything goes" content lives (definitions, contacts, background).
- **History**: the raw chronological log, as described in the base schema.
- `type: notiz` files (ordinary content files without a master role) have
  no Summary section, only History.

### `#important` marker
History entries that should always show up in the Summary regardless of
age, bypassing the recency window:

```markdown
### 2026-07-02 10:00
Baseline decision: no purchase above €45,000 regardless of condition #important
```

## Body conventions (no frontmatter, still part of the schema)

Entries inside a file are separated by a timestamp heading, followed by
free text or task lines:

```markdown
## 2026-09-05 14:32
Second viewing fell through #sailing #disappointment

- [ ] Check keel seal #task id:a3f1 due:2026-09-10 prio:high
- [x] Got a quote from the sailmaker #task id:9c02 done:2026-09-04
```

### Entry heading with a topic, and the meta line

An entry written through the **"Add entry" drawer** carries its
topic in the heading and its references on a trailing meta line:

```markdown
## 06:12 — Rollout-Sync
Kurzes Sync mit Team zu Rollout-Plan, Risiken bei DB-Migration besprochen.
#daily #arbeit · [[Markus]] · [[Rollout-Sync]]
```

- The heading is `## HH:mm` (or `## YYYY-MM-DD HH:mm`, `### …` in a master
  `## History`) optionally followed by ` — <Thema>`. An en dash or `--` is
  accepted as the separator; a title with **no** dash (`## 14:32 Rollout`)
  is still prose, not an entry heading.
- The meta line is `#tag #tag · [[Person]] · [[Meeting]]` — the tag group
  first, then people, then meetings, groups joined by ` · `. People and
  meetings use `[[wiki link]]` syntax so they resolve to their master
  documents like any other reference.
- Both parts are optional and omitted entirely when empty, so an entry with
  neither is byte-identical to the plain `## HH:mm` form above. Composition
  lives in `shared/entry-compose.ts`, parsing in `shared/entries.ts` — the
  same parser routing uses, so a topic-carrying entry routes normally.

- Inline `#tag` in the body text is parsed by the file watcher on save and
  merged into the frontmatter `tags` array (deduplicated) — frontmatter is
  the aggregated source of truth, body tags are the input for it.
  - **Implemented (milestone 6a):** the merge runs in the main-process
    `note:save` pipeline on an explicit save (no file watcher yet). It
    applies to ordinary topic notes only — files under `daily/` and
    `templates/` get `updated:` bumped but their `tags` array is left
    untouched (they are structural, not topic notes). `#task` and
    `#important` are treated as structural markers and are **not** merged
    as tags. Routing of tagged entries (milestone 6b) appends a dated copy
    into the tag's master-document `## History` — the daily note keeps its
    own copy, so content is deliberately duplicated between the timeline
    and the topic view. See
    `docs/09_architecture_decisions/0007-on-save-tag-pipeline.md`.
- `#task` with `id:` is mandatory for every task (not optional), so the
  later task center (Phase 4) can write checkbox clicks back to the source
  line unambiguously, independent of line-number shifts.
- `due:` and `prio:` are optional, `done:` appears only once checked off.

## Assistant sidecar files — `.{name}.chat.json`

The note assistant panel stores its per-note thread (the automatic summary
plus the questions and answers about that note) **beside** the note, not
inside it:

```
daily/2026-09-26.md  ->  daily/.2026-09-26.chat.json
```

```json
{
  "version": 1,
  "notePath": "daily/2026-09-26.md",
  "cards": [
    { "id": "…", "role": "summary", "text": "Kurze Notiz über …", "at": "2026-09-26T06:12:00" }
  ]
}
```

`role` is `summary` | `question` | `answer`. These files are **not** part
of the note schema and never affect it: nothing the assistant does writes
into a `.md` file. The dot prefix keeps them out of the file tree and the
tag index, which already skip dotfiles. A note copied without its sidecar
simply has no thread — the content is derived and can be regenerated. See
`docs/09_architecture_decisions/0012-note-assistant-sidecar-thread.md`.

## Inbox (`inbox.md`) — deliberately schema-free

A pure collection point, no per-entry frontmatter needed — every block just
holds raw text plus its origin (timestamp, source: external file / folder
proposal / untagged block pulled for review). Simple enough that its
structure can emerge directly from the inbox UI logic instead of being
pre-specified. (Quick-capture does **not** write here — it goes straight
into the day's daily note; see below.)

## Templates (`templates/`) — structural folder

Markdown templates for newly created notes. Placeholders substituted at
creation time: `{{date}}` (`2026-09-05`), `{{time}}` (`14:32`),
`{{datetime}}` (`2026-09-05T14:32:00`), `{{title}}` (same as `{{date}}`
for daily notes). Unknown `{{...}}` tokens are left untouched.

- `templates/daily.md` — seeds `daily/YYYY-MM-DD.md`. Scaffolded with a
  starter (base frontmatter + a `# {{date}}` heading + a first
  `## {{time}}` entry) the first time quick-capture needs it; edit it to
  change how future daily notes look.
- Later: the same mechanism seeds files created by tag routing.
- `templates/` is excluded from tag routing, folder proposals, and the
  tag overview.
