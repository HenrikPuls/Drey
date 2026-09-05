# 9. Architecture Decisions

Index of Architecture Decision Records (MADR-style: Title, Status,
Context, Decision, Consequences). One file per decision under
[09_architecture_decisions/](09_architecture_decisions/), numbered
sequentially. Written for structural/lasting decisions with real
trade-offs — not for routine implementation choices (a specific npm
package, a minor naming convention).

| # | Title | Status |
|---|---|---|
| [0001](09_architecture_decisions/0001-electron-process-split-contextbridge.md) | Electron main/renderer process split via contextBridge | Accepted |

Decisions not yet written up (relevant spec already fixes them, but the
ADR is deferred to the milestone that actually implements them, per
`CLAUDE.md`'s "fill in incrementally" guidance):

- Storage format: plain Markdown + YAML frontmatter, no database
  (relevant from milestone 2, vault/file access)
- Tag-first classification vs. LLM-per-capture
  (relevant from milestone 5, tag parsing/routing)
- Master-document/tag mechanism
  (relevant from milestone 5–6)
