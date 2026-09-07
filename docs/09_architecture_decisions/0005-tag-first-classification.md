# 5. Tag-first classification vs. LLM-per-capture

> **Superseded by [ADR-0017](0017-tags-as-labels-and-section-index.md).**
> Tags are now free inline labels with no deterministic routing and no
> LLM classifier on the capture path; tag _suggestion_ survives as the
> manual Autotag button. The alternatives analysis below is kept for the
> record.

## Status

Superseded by [0017] — was: Accepted, the spec fixed this from the start
(`specs/roadmap.md`, `specs/classifier-spec.md`), recorded when milestone
6 implemented it.

## Context

Every captured thought has to end up associated with a topic (and,
secondarily, marked as a task or a plain note). Two broad ways to do that:

1. **LLM per capture.** Every entry goes to the local model, which returns
   a topic (and task/note, due date, priority). Simple mental model — one
   path for everything — but every capture blocks on an inference call,
   the model is a hard dependency for the core flow, and a mis-classified
   topic is only visible after the fact.
2. **Tag-first.** The user assigns the topic themselves inline
   (`#sailing`), helped by autocomplete over the known tag vocabulary. A
   known tag routes deterministically with **no** model call. The LLM is a
   fallback, used only for entries that carry no tag at all, and then in a
   background batch (the inbox), never on the capture path.

`specs/classifier-spec.md` ("Why two prompts instead of one") already
argues for the second: the common case is a tiny, instant, offline
operation; the model — a small one sharing a 12 GB GPU with benchmarking
work (`docs/11`) — is only touched for the exception, asynchronously.

## Decision

Tag-first. A typed, known `#tag` is the primary assignment path and is
fully deterministic:

- `TagIndex` (main process) holds the vault-wide tag vocabulary, scanned
  from every `type: master` document's frontmatter. It is the single
  source for both `#tag` autocomplete (`tag:list`) and — from milestone 7
  — the classifier registry (`tag:registry`).
- The editor offers `#tag` completion from that vocabulary
  (`markdownLanguage.data` completion source, milestone 6a).
- On save, `note:save` merges inline `#tag`s into the note's frontmatter
  `tags` (the aggregated source of truth) and, from milestone 6b, routes
  each tagged dated entry to its topic's master document — no model call
  anywhere in this path.
- `tags[0]` is the primary tag. Its meaning for physical layout is the
  subject of [ADR-0006](0006-master-document-tag-mechanism.md) and
  [ADR-0007](0007-on-save-tag-pipeline.md).

The LLM classifier (task/note detection, tag suggestion for untagged
entries) is milestones 7–8 and runs off the capture path.

## Consequences

- The core capture→file flow has **no runtime dependency on LM Studio**.
  The app is fully usable — capture, tag, route, search later — with no
  model loaded.
- Autocomplete quality depends on the master documents existing. A vault
  with no `type: master` files offers no completions; the first note for a
  topic is typed free-hand, and the master doc (and thus the tag entry) is
  created deliberately (milestone 6b / 8).
- Determinism moves the failure mode from "model guessed wrong" to "user
  typed a tag that doesn't exist yet" — handled by the inbox
  confirmation flow (milestone 8), not by silently creating structure.
- `TagIndex` is in-memory and rebuilt on vault select / after a
  tag-changing save. With no file watcher yet, an external edit to a
  master doc is not reflected until the next rebuild (`docs/11`).
