# 1. Introduction and Goals

## 1.1 Vision

A local, topic-based note-taking app. It runs in the background; thoughts
land in Markdown files via quick-capture, a local LLM classifies them
automatically (topic/person/task), and asks when unsure instead of
misfiling silently.

See [`specs/roadmap.md`](../specs/roadmap.md) for the full concept and
phased scope.

## 1.2 Requirements Overview

The binding requirements live in `specs/`, not duplicated here:

- [`specs/roadmap.md`](../specs/roadmap.md) — phased feature scope
  (Phase 1 MVP through Phase 4 and Future Scope)
- [`specs/frontmatter-schema.md`](../specs/frontmatter-schema.md) — file
  and frontmatter format
- [`specs/classifier-spec.md`](../specs/classifier-spec.md) — LLM prompts
  for task/note detection and tag suggestions

Current build scope is Phase 1 (MVP) only — see the roadmap's "Phase 1"
section and `CLAUDE.md`'s "Current Scope" / "Build Order" for the
milestone breakdown.

## 1.3 Quality Goals

*(To be elaborated in [10_quality_requirements.md](10_quality_requirements.md)
as concrete scenarios once more of the app exists to reason about. Known
priorities from the spec, in rough order:)*

1. **No silent misfiling** — the app asks when classification confidence
   is low rather than guessing wrong quietly.
2. **No proprietary lock-in** — plain Markdown + YAML must stay readable
   and editable outside the app at all times.
3. **Local-first / private** — no cloud calls; local LLM only.
4. **Low interaction cost** — tag-first capture must stay fast (no LLM
   round-trip on the common path).

## 1.4 Stakeholders

| Role | Concern |
|---|---|
| User (also the developer) | Daily-use note capture and retrieval tool; sole intended user for the MVP. |
