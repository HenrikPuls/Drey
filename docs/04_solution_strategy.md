# 4. Solution Strategy

Key strategic decisions from `specs/roadmap.md`'s "Core Architectural
Principles", restated here as the top-level strategy this architecture
follows. Trade-offs behind the ones with real alternatives are captured as
ADRs under [09_architecture_decisions/](09_architecture_decisions/).

| Goal | Strategy |
|---|---|
| No proprietary lock-in, future-proof storage | Plain Markdown + YAML frontmatter as the sole source of truth (no database). |
| Fast, low-friction capture | Tag-first routing: a known `#tag` deterministically routes a note with no LLM call. The LLM is only a fallback for untagged input. |
| Privacy, no ongoing cost | Local LLM via LM Studio, no cloud calls, no fixed/hardcoded model. |
| Security boundary between UI and system access | Electron main/renderer split; renderer has no Node integration, all filesystem/LLM access goes through a typed `contextBridge` IPC surface. |
| Folder structure that scales with actual use instead of upfront design | Folders are not hardcoded — they emerge per tag; the LLM proposes new folders, confirmed via the inbox review queue (no blocking popups). |
| Responsiveness under load | Interactive requests (capture, chat) always take priority over background jobs (batch tag suggestion, summaries, future re-indexing). |

Build order follows the milestones in `CLAUDE.md` ("Build Order"): shell
and scaffold first, then vault access, editor, capture, tagging/routing,
classification, inbox, search, summaries — each a working, demoable slice
rather than one big-bang implementation.
