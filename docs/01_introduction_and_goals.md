# 1. Introduction and Goals

## 1.1 What Drey is

Drey is a desktop note-taking app for one person on one machine. Notes
are plain Markdown files in a folder the user chooses (a **vault**); Drey
edits them in place, keeps them searchable, and can hand them to a
language model the user has connected.

Three things define it:

- **The files belong to the user.** A vault is an ordinary folder. Every
  note stays readable and editable in any other program; Drey keeps no
  database beside it that the notes depend on.
- **Structure comes from labels, not from folders.** A note is organised
  by `#tags` written in its text. Drey indexes them; it never moves a
  file because of a tag.
- **The model helps on request.** Capture and editing never wait for a
  model. The assistant answers questions about the notes, suggests tags
  and runs user-defined actions, and every change it proposes to a note
  is shown as a diff first.

## 1.2 Where the requirements live

The requirements are not repeated in this documentation. They are in
`specs/`:

| File | Holds |
|---|---|
| [`specs/roadmap.md`](../specs/roadmap.md) | the concept, the fixed principles, open work in order, open risks |
| [`specs/changelog.md`](../specs/changelog.md) | what has shipped, newest first |
| [`specs/decisions.md`](../specs/decisions.md) | ideas that were excluded or decided against |
| [`specs/frontmatter-schema.md`](../specs/frontmatter-schema.md) | the file formats: frontmatter, tag and task grammar, the folders Drey creates |
| [`specs/classifier-spec.md`](../specs/classifier-spec.md) | every prompt sent to a model, with its builder and parser |

## 1.3 Quality goals

In order of priority. Section [10](10_quality_requirements.md) turns each
into scenarios that can be checked.

| # | Goal | What it means here |
|---|---|---|
| 1 | **The user's text is never lost** | A save either completes or leaves the old file; a conflict is asked about, not resolved silently; what a write replaces can be restored. |
| 2 | **No lock-in** | Plain Markdown with optional YAML frontmatter. Deleting Drey loses no content. |
| 3 | **Private by default** | Out of the box Drey talks only to a model on the local machine. Everything that reaches the network is opt-in and off by default. |
| 4 | **Writing is never blocked** | Typing, capture and saving do not wait for a model or for an index. |
| 5 | **Features can be added and removed without touching the core** | A feature is a plugin behind a published interface; disabling one leaves the rest working. |

## 1.4 Stakeholders

| Role | Concern |
|---|---|
| The user, who is also the developer | A dependable daily tool for capturing and finding notes. |
| A plugin author | A stable, documented interface ([`plugins/TUTORIAL.md`](../plugins/TUTORIAL.md), [`plugins/AUTHORING.md`](../plugins/AUTHORING.md)) that does not break between versions. |
| A coding agent working on the repository | An unambiguous answer to "where does this change go" ([§5](05_building_block_view.md)). |
