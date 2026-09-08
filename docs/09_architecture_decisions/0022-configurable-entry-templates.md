# 22. Configurable "Add entry" templates

## Status

Accepted — extends the entry-drawer output that
[ADR-0017](0017-tags-as-labels-and-section-index.md) fixed as
`## HH:mm[ — Topic]` / text / `#tag` line. Config lives in
`app-config.json` ([ADR-0010](0010-app-settings-storage.md)) and reuses
the Actions template pattern (built-in re-injection by stable id).

## Context

The drawer appended one hard-coded shape (`shared/entry-compose.ts`
`composeEntry`). The project owner wanted to choose the layout — a
timestamp, an optional title, a horizontal rule, then the tags — and to
be able to keep the old shape, or configure further ones. So: a
template with placeholders, selectable in Settings, not a second fixed
format.

Two things constrain how free the template can be:

- **The heading line is structural.** `parseDatedEntries`
  (`shared/entries.ts`) — used by routing, the daily-note section index
  and the master-document History — only recognises an entry whose first
  line is `## HH:mm` / `## YYYY-MM-DD HH:mm` (optionally ` — <Topic>`). A
  template whose first line is something else produces text nothing
  indexes or routes.
- **Round-trip cleanliness.** If a template puts a `---` rule (and a tag
  line) under the heading, `parseDatedEntries` would capture them into the
  entry's `text`.

## Decision

**An `entry: { templates: EntryTemplate[]; activeId: string }` slice on
`AppConfig`, a placeholder-substituting `composeEntry`, and a small
parser tweak.**

- `EntryTemplate = { id, name, pattern, builtin: 'classic' | 'ruled' |
  null }`. `normalizeEntryConfig` re-injects both built-ins exactly once
  (keeping the user's `name`/`pattern` edits, matched by id), then appends
  well-formed user templates — the same code shape as
  `normalizeTemplates` for Actions. `activeId` falls back to the classic
  built-in id when it names no known template.
- Placeholders: `{{time}}`, `{{date}}`, `{{datetime}}`, `{{title}}`
  (`''` or ` — <Topic>`), `{{tags}}` (`''` or `#a #b`), `{{content}}`
  (`''` or the body). `substitutePlaceholders` (new `shared/placeholders.ts`,
  also adopted by `electron/daily-note.ts`) does the `{{key}}` replace;
  `substituteEntryTemplate` then tidies:
  - a pattern line that was **only** placeholder(s) and rendered empty is
    dropped entirely — this is what keeps an empty entry a bare `## HH:mm`
    for every template, and keeps **Classic** byte-identical to the old
    output;
  - blank runs collapse to one, no leading/trailing blank line;
  - a trailing horizontal-rule line is removed (a topic-only **Ruled**
    entry would otherwise end on a dangling `---`).
- Built-in patterns:
  - **Classic**: `## {{time}}{{title}}\n{{content}}\n{{tags}}`
  - **Ruled**: `## {{time}}{{title}}\n---\n{{tags}}\n\n{{content}}`
- `composeEntry` / `entryInsertion` / `appendEntry` take the `pattern`
  explicitly (`shared/` stays pure). The renderer resolves the active
  pattern in `SettingsService.activeEntryPattern()` (persisted config,
  never the draft) and threads it: `EntryDraftService` →
  `EditorService.requestEntryFromDraft(draft, pattern)` →
  `NewEntryRequest.pattern` → `Editor.applyNewEntryRequest` →
  `entryDraftEdit`.
- `parseDatedEntries` strips a leading rule line from an entry's `text`,
  and a leading `#tag` line **only when a blank line follows it** (the
  exact Ruled `{{tags}}\n\n{{content}}` signature) — a Classic body that
  opens with a hashtag is untouched. Tags left in the body are still
  indexed (`TagIndex` scans the whole section).
- Settings gains an "Add entry" category (`SettingsEntry`, mirrors
  `SettingsActions`): template list, active-template radio, name +
  pattern editor, add/delete for non-built-ins, a placeholder legend and
  a live `composeEntry` preview.

## Consequences

- The old format is now "the Classic template"; existing
  `entry-compose.spec.ts` assertions hold when the classic pattern is
  passed explicitly.
- A custom template whose first line is not a timestamp heading silently
  stops routing / section-indexing that entry — documented in
  `specs/frontmatter-schema.md` and `docs/11`, not guarded. A soft
  warning in the pane is a possible follow-up.
- `parseDatedEntries` gained two `replace` steps; both are anchored and
  narrow (one rule line, one tag line gated to a following blank), so a
  Classic body is never eaten — covered by `entries.spec.ts`.
- `substitutePlaceholders` is shared with the daily-note template, so
  both substitution paths behave identically.
