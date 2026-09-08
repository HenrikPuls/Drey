# File & Frontmatter Schema

Frontmatter is **optional** and app-managed. A note is just Markdown; the
tag system reads the **body**, not the header. The only fields the app
understands are `title`, `created` and `updated`.

## Frontmatter (optional)

```yaml
---
title: 'Boat purchase'
created: '2026-08-01'
updated: '2026-09-05T14:32:00'
---
```

- All three fields are optional. A file with **no `---` fence** is written
  back byte-for-byte on save — the app never adds a header that wasn't
  there.
- When a fence **is** present, `note:save` bumps `updated:` to the save
  time and fills `created:` with today's date if it is missing. No other
  field is touched, added or removed.
- ⚠️ Always write dates as a **quoted string** (`"2026-09-05"`), never
  unquoted — some YAML parsers auto-convert unquoted dates into `Date`
  objects, which breaks round-tripping if another tool ever reads these
  files.
- There is no `type`, `tags`, `art`, `description` or `aliases` field any
  more. Earlier versions used frontmatter `tags:` as an aggregated source
  of truth and `type: master` documents as classifier context; both are
  gone (see `docs/09_architecture_decisions/0017-tags-as-labels-and-section-index.md`).

### Editor display

The editor keeps the frontmatter in the file but **folds it behind a pill**
(`▸ Frontmatter · N fields`) by default, in both Live Preview and source
mode — a note opens as prose, not metadata. Clicking the pill expands the
block to dim, editable raw YAML with a chevron to fold it back; the fold
state is remembered per open tab. There is no structured field editor;
expanding edits the YAML directly. See
`docs/09_architecture_decisions/0009-live-preview-decorations.md`.

## Body conventions (the part that actually carries meaning)

### Entries — timestamp headings

Entries inside a file are separated by a timestamp heading, followed by
free text or task lines:

```markdown
## 2026-09-05 14:32

Second viewing fell through #sailing #disappointment

- [ ] Check keel seal #task id:a3f1 due:2026-09-10 prio:high
- [x] Got a quote from the sailmaker #task id:9c02 done:2026-09-04
```

### Entry heading with a topic, and the meta line

An entry written through the **"Add entry" drawer** may carry a topic in
the heading and its tags on a trailing meta line:

```markdown
## 06:12 — Rollout-Sync

Kurzes Sync mit Team zu Rollout-Plan, Risiken bei DB-Migration besprochen.
#daily #arbeit #rollout-sync
```

- The heading is `## HH:mm` (or `## YYYY-MM-DD HH:mm`) optionally followed
  by ` — <Topic>`. An en dash or `--` is accepted as the separator; a
  heading with **no** dash (`## 14:32 Rollout`) is plain prose, not an
  entry heading.
- The meta line is just `#tag #tag …`. There are no `[[wikilink]]`
  people/meeting groups any more — a person or a meeting is written as an
  ordinary tag (`#markus`, `#rollout-sync`).
- Both the topic and the meta line are optional and omitted entirely when
  empty, so an entry with neither is byte-identical to a plain `## HH:mm`
  block. Composition lives in `shared/entry-compose.ts`.
- The exact layout is a **template** (`AppConfig.entry`, Settings → Add
  entry) with `{{time}} {{date}} {{datetime}} {{title}} {{tags}}
  {{content}}` placeholders. The example above is the built-in **Classic**
  template. The built-in **Ruled** template puts a `---` rule and the tag
  line right under the heading:

  ```markdown
  ## 08:15 — Urlaub-Ideen
  ---
  #urlaub #planung

  Mallorca oder Kroatien, Flüge im März checken.
  ```

  `parseDatedEntries` strips a leading rule line from an entry's `text`,
  and a leading `#tag` line **only when a blank line follows it** (the
  Ruled signature) — a Classic body that opens with a hashtag is left
  alone. A custom template's first line must still be a `## HH:mm[ —
  Topic]` heading or the entry is not recognised (no daily-note section
  index, no routing).

### Inline `#tag`s

- `#` + a letter, then letters/digits/`_`/`-`; matched at start of line or
  after whitespace; lower-cased. Fenced and inline code spans are ignored.
- **Nested tags:** segments joined with `/`, e.g. `#project/frontend/api`.
  The first segment must start with a letter (so `## 2026-09-05` headings
  never match); later segments may start with a digit (`#project/2024`). A
  trailing or doubled `/` is not part of the tag. These are **label
  hierarchies, not folders** (ADR-0017) — a tag search for `#project` also
  returns every `#project/*` section. The canonical grammar lives in
  `shared/tags/tags.ts` (`TAG_NAME_SOURCE`).
- `#task` is a **reserved structural marker** (task lines) and is never a
  tag — nor is any `#task/*` sub-tag. `#important` no longer carries special
  meaning — it is an ordinary, searchable tag.
- Inline tags are **not** merged into frontmatter. They are read straight
  from the body by the main-process tag index (`electron/tags/`), which
  keeps the tag vocabulary (for autocomplete + the search tag picker) and
  an inverted index of tagged `##`/`###` sections (for tag search). See
  `specs/classifier-spec.md` and
  `docs/09_architecture_decisions/0017-tags-as-labels-and-section-index.md`.

### Tasks

- `#task` with `id:` is **mandatory** for every task, so the later task
  center (Phase 4) can write checkbox clicks back to the source line
  unambiguously, independent of line-number shifts.
- `due:` and `prio:` are optional; `done:` appears only once checked off.

## Daily notes — `daily/<year>/<month>/YYYY-MM-DD.md`

One file per calendar day, in the structural `daily/` folder, nested by
year and month (e.g. `daily/2026/09/2026-09-26.md`). Older flat
`daily/YYYY-MM-DD.md` files are still opened if present. Created by the
quick-capture hotkey from `templates/daily.md`; entries are appended as
`## HH:mm` timestamp headings. `daily/` **is** indexed for tag search
(unlike `templates/`). Path handling lives in `shared/daily.ts`
(`dailyPathFor` / `dailyDateFromPath`).

## Assistant sidecar files — `.{name}.chat.json`

The note assistant panel stores its per-note thread (the automatic summary
plus the questions and answers about that note) **beside** the note, not
inside it:

```
daily/2026/09/2026-09-26.md  ->  daily/2026/09/.2026-09-26.chat.json
```

```json
{
  "version": 1,
  "notePath": "daily/2026/09/2026-09-26.md",
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

## Templates (`templates/`) — structural folder

Markdown templates for newly created notes. Placeholders substituted at
creation time: `{{date}}` (`2026-09-05`), `{{time}}` (`14:32`),
`{{datetime}}` (`2026-09-05T14:32:00`), `{{title}}` (same as `{{date}}`
for daily notes). Unknown `{{...}}` tokens are left untouched.

- `templates/daily.md` — seeds `daily/<year>/<month>/YYYY-MM-DD.md`.
  Scaffolded the first time quick-capture needs it with an optional
  `title` / `created` / `updated` frontmatter, a `# {{date}}` heading and
  a first `## {{time}}` entry; edit it to change how future daily notes
  look.
- `templates/` is excluded from the tag index and tag search.
