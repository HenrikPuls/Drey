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
- ⚠️ Technical note: always write dates as a **quoted string**
  (`"2026-09-05"`), never unquoted. Some YAML parsers auto-convert unquoted
  dates into Date objects, which can cause inconsistencies if a script in a
  different language ever touches these files too.

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

- **Summary**: the only section that gets auto-overwritten — triggered by a
  manual "Update summary" button (no silent background regeneration).
  Weighting: last 7 days (or last N entries, for irregular activity) go in
  in full, older material gets compressed to a half-sentence or dropped.
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

- Inline `#tag` in the body text is parsed by the file watcher on save and
  merged into the frontmatter `tags` array (deduplicated) — frontmatter is
  the aggregated source of truth, body tags are the input for it.
- `#task` with `id:` is mandatory for every task (not optional), so the
  later task center (Phase 4) can write checkbox clicks back to the source
  line unambiguously, independent of line-number shifts.
- `due:` and `prio:` are optional, `done:` appears only once checked off.

## Inbox (`inbox.md`) — deliberately schema-free

A pure collection point, no per-entry frontmatter needed — every block just
holds raw text plus its origin (timestamp, source: quick-capture / external
file / folder proposal). Simple enough that its structure can emerge
directly from the inbox UI logic instead of being pre-specified.
