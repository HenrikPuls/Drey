# 7. On-save tag pipeline (`note:save`), and routing as an append-copy

## Status

Accepted — implemented across milestone 6a (frontmatter merge + `updated:`
bump) and 6b (routing tagged entries into master-document History).
Contains two live deviations from `specs/`.

## Context

`specs/frontmatter-schema.md` says two things happen "on save":

1. inline `#tag`s in the body are parsed and **merged into the frontmatter
   `tags` array** (frontmatter is the aggregated source of truth), and
2. `updated:` is **bumped**.

It attributes both to the **chokidar file watcher**. No file watcher
exists yet (it is a later Phase-1 item), and milestone 3 explicitly
deferred the `updated:` bump for want of a YAML round-trip
(`docs/05` §5.5).

Separately, `specs/roadmap.md` says the primary tag "determines the
physical location (one place, no symlink/duplicate)" — written with a
topic *note file* in mind. During milestone 6 planning the project owner
refined what routing should actually do for the common case (a daily note
whose entries carry tags): **the daily note stays put and keeps its
content; the tagged entries are copied, dated, into the topic's master
document.** Content is deliberately duplicated — the daily note is the
raw timeline, the master document is the topic-centric view.

## Decision

### The pipeline runs in the main process, behind a new `note:save` channel

`EditorService.save()` calls `saveNote(NoteSaveRequest)` instead of
`vault:write-file` for `.md` documents. `NoteManager` (main):

1. split frontmatter; no fence → write bytes verbatim, done;
2. merge inline `#tag`s into `tags` (topic notes only — `daily/` and
   `templates/` keep their `tags`; `#task` / `#important` are never tags);
3. `bumpUpdated` (`updated:` = now; `created:` filled if absent);
4. `writeFrontmatter` — a targeted `yaml` node mutation, every untouched
   key/comment/style preserved, date fields double-quoted;
5. **(milestone 6b)** for each dated entry carrying a known tag, append a
   dated copy to that tag's master-document `## History` section, with a
   `<!-- drey:src <path>@<HH:mm> -->` marker so re-saving never
   double-appends;
6. write the note back **in place** (no move), apply the file's EOL;
7. return `NoteSaveResult` — the rewritten `content` (adopted by the
   editor as saved + buffer), `modifiedMs`, `tags`, `unknownTags` (for the
   milestone-8 inbox), `appendedTo`.

All decision logic is pure `shared/` code (`frontmatter.ts`,
`inline-tags.ts`, `entries.ts`, `history.ts`) that the renderer test suite
covers; `NoteManager` only sequences filesystem calls (Vitest cannot see
`electron/`).

**Rationale for main-process, single channel:** routing needs the
main-process `TagIndex` and produces a new content string the editor must
adopt; splitting the frontmatter merge into the renderer would give
frontmatter two owners. One chokepoint is also exactly what the future
file watcher will reuse for external edits.

### Routing is an append-copy into `## History`, not a file move

Deliberate duplication. The daily note keeps its `## HH:mm` entry; the
master document gains a `### <date> <time>` History entry with the same
text. `specs/roadmap.md`'s "no duplicate" line refers to not putting the
same *file* in two folders — that still holds (nothing is moved or
symlinked). The master-document History section
(`specs/frontmatter-schema.md`) is built for this aggregation.

## Consequences

- **Deviation 1:** the `#tag` merge + `updated:` bump run in `note:save`
  on an explicit save, not the watcher. When the watcher lands it should
  call the same `NoteManager` path for externally-changed files.
  `specs/frontmatter-schema.md` updated to say so.
- **Deviation 2:** routing duplicates content by design.
  `specs/frontmatter-schema.md` updated; `specs/roadmap.md` gets a note.
- `EditorService.save()` adopts the returned `content` as **both**
  `savedContent` and `bufferContent`, so the merged frontmatter is visible
  and the tab is clean. `Editor.loadActiveDoc()` keeps the caret on a
  same-file reload instead of jumping to offset 0.
- The EOL transform moved from `EditorService` to `NoteManager`; the
  renderer sends the LF buffer plus an `eol` flag. This one line is
  main-only and unit-test-uncovered (`docs/11`).
- Structural notes (`daily/`, `templates/`) still get `updated:` bumped.
- No file watcher means `TagIndex` and any open master-doc tab can go
  stale on an external edit until the next rebuild / reopen (`docs/11`).
- `yaml` is a new dependency — main-process only, verified absent from the
  renderer bundle.
