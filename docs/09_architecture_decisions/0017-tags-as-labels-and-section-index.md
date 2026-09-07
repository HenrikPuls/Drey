# 17. Tags as free labels + an inverted section index + tag search

## Status

Accepted — implemented in milestone 11. **Supersedes
[ADR-0005](0005-tag-first-classification.md),
[ADR-0006](0006-master-document-tag-mechanism.md) and
[ADR-0007](0007-on-save-tag-pipeline.md).**

## Context

The original tag design was three linked ADRs:

- **0005** tag-first classification — a typed known `#tag` routes
  deterministically, the LLM only guesses for untagged input;
- **0006** one `type: master` document per tag, carrying `art` /
  `description` / `aliases` and a fixed Summary / Context / History body;
- **0007** an on-save pipeline that merges inline `#tag`s into the
  frontmatter `tags[]` array (the "aggregated source of truth") and
  append-copies each tagged dated entry into its tag's master-document
  `## History`.

In use this proved heavy. The **whole** tag system leaned on frontmatter
(`tags[]`, `type`, `art`, `description`, `aliases`), which is what made
the header feel like mandatory bookkeeping. It also carried a lot of
automation surface that was never finished or never sat right: the
`<tag>.md` → `<tag>/_index.md` folder promotion, new-tag gating through
an inbox, an LLM registry derived from `description` fields, deliberate
content duplication between the daily note and the master document, and
near-duplicate tags (`sailing` vs. `boat`) with only a one-time
confirmation as a brake.

An **intermediate redesign** — tags as directories, an `overview.md` per
tag, automatic aggregation up the tree via an LLM delta-cascade — was
drafted and then **rejected in review**: still too much automatic
machinery, too many undefined edges (what happens on rename, on a
partial cascade, on a conflicting edit).

What was actually wanted, stated plainly: type a `#tag` freely; have the
app _suggest_ tags that already exist; and be able to pull up "every
place tag A and tag B (and maybe this free text) appear" as a list with
clickable links into the files, optionally with a prose summary.

## Decision

### Tags are free inline `#tag` labels

`#` + a letter, then letters/digits/`_`/`-`, lower-cased; matched at start
of line or after whitespace; code spans ignored. No creation flow, no
"unknown tag" concept, no folders, no routing, no aggregation. `#task`
stays a reserved structural marker; `#important` is demoted to an
ordinary, searchable tag.

### Frontmatter loses every tag-system consumer

`note:save` keeps only what [ADR-0007](0007-on-save-tag-pipeline.md) step
1/3 did: on a file that already has a `---` fence, bump `updated:` and
fill `created:` if absent. The `#tag` → `tags[]` merge and the
master-document History append-copy are **removed**. `NoteSaveResult`
drops `tags` / `unknownTags` / `appendedTo`. `specs/frontmatter-schema.md`
is rewritten to "optional, `title` / `created` / `updated` only".

### `TagIndex` (main, `electron/tags/`) = vocabulary + tagged sections

- `vocabulary: Map<tag, count>` — feeds `#tag` autocomplete and the
  search panel's tag picker; IPC `tags:list` → `TagEntry = { tag, count }`
  (no `aliases` / `art` / `description` / `hasMaster` / `masterPath`).
- `SectionRecord[]` — `{ path, heading, level, line, tags, text }` for
  every `##` / `###` section that contains at least one tag.
- Full rebuild on vault open and on manual refresh
  ([ADR-0018](0018-manual-refresh-no-file-watcher.md)); `reindexFile(path,
content)` on save; `removeFile(path)` on delete. `templates/` excluded,
  `daily/` **included**.

### Pure matcher and helpers in `shared/tags/`

- `splitSections(body)` → `Section[]` (`{ heading, level, line, text }`; a
  section runs to the next heading of any level; content before the first
  heading is an implicit section; fenced code skipped).
- `extractInlineTags` / `extractTagOccurrences` (names, and positions for
  snippets / line numbers).
- `runTagSearch(records, { tags, text })` — AND over `tags`, AND over
  whitespace-split free-text terms, each matched in a section's `text`
  **or** its `heading`; free text alone is allowed. Hits
  (`{ path, heading, line, snippet, text }`) are ordered by path then
  line.
- `formatSearchResultsDoc(query, hits)` — Markdown: a query header, then
  per hit `## <path>:<line>` and the whole section text.

`shared/tag-registry.ts`, `shared/history.ts`, `shared/inline-tags.ts`
and `electron/tag-index.ts` are deleted.

### Search UI — a sidebar panel, open-at-line, and Export

`src/app/tags/SearchPanel` is a collapsible "Search" section in the
sidebar: tag chips (with a vocabulary datalist), a free-text field, a
section-level hit list. Clicking a hit opens the file at the hit's line
(`EditorService.openFileAt` + a `revealRequest` signal the `Editor`
consumes). An **Export** button writes `formatSearchResultsDoc` into an
unsaved `search-results.md` scratch tab
(`EditorService.openScratch`, see the
[ADR-0003](0003-multi-document-editor-tab-model.md) addendum). `Ctrl+Shift+F`
opens and focuses the panel through the keybinding registry
([ADR-0016](0016-feature-module-convention.md)); a `Ctrl`/`Cmd`-click on a
`#tag` pill in the editor replaces the query with that tag and runs it.

### The LLM result digest is wired but parked

`tags:summarise-results` + `ActionRunner.summariseSearchResults` + the
`search-summary` built-in template exist and are tested, but the panel's
"Summarise" button was removed in favour of the plain-Markdown Export.
Reason: the digest needs a configured local model, and a stale
`dist-electron` (CLAUDE.md's staleness trap) surfaces the failure as an
opaque "error invoking remote". Re-enabling it is a UI-only change.

### Tag _suggestion_ survives, reshaped

The **Autotag** button (drawer) sends the entry text plus the tag
**vocabulary** (not a described registry) to the model;
`{"tags": [...]}` pre-fills the drawer's tag field, confirmed by saving.
No inbox, no folder proposal. See `specs/classifier-spec.md`.

## Consequences

- Frontmatter is genuinely optional and vestigial now — the header is no
  longer where topic information lives.
- **No content duplication.** A daily entry is not copied anywhere; the
  "topic view" is a search result computed on demand, not a maintained
  file. The recency-weighted master-document Summary (old milestone 9) is
  gone with it (see the [ADR-0011](0011-unified-confirmation-flow.md)
  update).
- `TagEntry` shrinks to `{ tag, count }`; a large amount of code
  (`route()`, `appendToMaster`, tag-merge, the registry, History
  helpers, the inbox) is deleted rather than maintained.
- Search is a full in-memory scan of `SectionRecord[]` — fine at expected
  vault sizes; a dedicated FTS index is the Phase-2 step
  (`specs/roadmap.md`).
- The rejected path-based `overview.md` / delta-cascade design is
  recorded here so it is not re-proposed.
- Determinism's failure mode ("user typed a tag that doesn't exist yet")
  simply disappears — there is nothing a tag has to match.
