# 6. Master-document / tag mechanism

> **Superseded by [ADR-0017](0017-tags-as-labels-and-section-index.md).**
> There are no `type: master` documents, no `art` / `description` /
> `aliases`, and no `<tag>/_index.md` promotion. A tag's "view" is now a
> search result computed on demand, not a maintained file.

## Status

Superseded by [0017] — was: Accepted, fixed by
`specs/frontmatter-schema.md` and `specs/roadmap.md`, recorded when
milestone 6 built on it.

## Context

Folder structure in Drey is **not hardcoded** — it emerges per tag
(`specs/roadmap.md`, "Core Architectural Principles"). Something has to be
the anchor for a topic: the thing autocomplete lists, the classifier reads
for context, the glossary/overview opens, and (later) the summary is
written into. The options considered in the specs were a separate glossary
store, a database table per tag, or a plain file per tag. The specs pick
the last, and fold the old separate "glossary" concept into it.

## Decision

**One `type: master` Markdown document per tag**, carrying in its
frontmatter:

- `art` — `thema | person | team | projekt | begriff` (what kind of thing
  the tag denotes; replaces the earlier topic/person split and the three
  glossary categories),
- `description` — one sentence, the classifier context,
- `tags[0]` — the tag this document owns (its primary tag),
- `aliases` — alternative spellings that autocomplete should also match
  (`#boat` → `sailing`).

Its body has three fixed sections: **Summary** (the only
machine-overwritten part, via a manual button, milestone 9), **Context**
(free, never touched by automation), and **History** (the chronological
log that routing appends to).

Physical layout follows `tags[0]`:

- While a topic is small, its master document lives at the vault root as
  `<tag>.md`.
- Once it grows, the master document becomes `<tag>/_index.md` and further
  notes for that tag sit alongside it in `<tag>/`, inheriting the primary
  tag without needing `art` / `description` themselves.

`TagIndex` builds the tag vocabulary and the classifier registry by
scanning these documents (milestone 6a). `daily/` and `templates/` are
structural, not topics, and are excluded everywhere.

## Consequences

- No database, no proprietary store — a tag's identity, context and log
  are one human-readable file. Fully inspectable and editable outside the
  app.
- The registry the classifier needs (`- <tag> (<art>): <description>`) is
  derived, not maintained separately — `formatRegistry()` over the scanned
  masters.
- The root-`<tag>.md` → `<tag>/_index.md` promotion (and sweeping loose
  sibling notes into the new folder) is a real filesystem operation with
  edge cases; milestone 6 does **not** implement it (routing only appends
  to a master document that already exists). Deferred, tracked in
  `docs/11`.
- Two master files claiming the same primary tag is possible (hand-editing,
  or the "sailing" vs. "boat" near-duplicate risk in `specs/roadmap.md`).
  `TagIndex` currently lets the last one scanned win; the inbox review
  (milestone 8) is the intended brake.
- A tag with no master document still appears in the vocabulary (it was
  used in some note's `tags[]`) but has `hasMaster: false` — it cannot be
  a routing target and contributes nothing to the classifier registry.
