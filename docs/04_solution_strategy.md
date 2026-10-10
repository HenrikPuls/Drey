# 4. Solution Strategy

Key strategic decisions from `specs/roadmap.md`'s "Core Architectural
Principles", restated here as the top-level strategy this architecture
follows. Trade-offs behind the ones with real alternatives are captured as
ADRs under [09_architecture_decisions/](09_architecture_decisions/).

| Goal | Strategy |
|---|---|
| No proprietary lock-in, future-proof storage | Plain Markdown + YAML frontmatter as the sole source of truth (no database). |
| Fast, low-friction capture | Capture is typing into the note: the slash menu's Entry block plus free inline `#tag` labels. No LLM call sits in the capture path; the LLM only *suggests* tags on request. |
| Privacy, no ongoing cost | Local OpenAI-compatible LLM by default (LM Studio default), no fixed/hardcoded model. Cloud and CLI providers are opt-in exceptions, each off by default (ADR-0047). |
| Security boundary between UI and system access | Electron main/renderer split; renderer has no Node integration, all filesystem/LLM access goes through a typed `contextBridge` IPC surface. |
| Structure that scales with actual use instead of upfront design | The folder structure is the user's own; topics are free inline `#tag` labels over a per-vault section index, never directories (ADR-0017). |
| Responsiveness under load | Interactive requests (capture, chat) always take priority over background jobs (batch tag suggestion, summaries, future re-indexing). |

The build proceeded in milestones — each a working, demoable slice rather
than one big-bang implementation. The log lives in
[milestones-done.md](milestones-done.md) (1–27) and
[`specs/changelog.md`](../specs/changelog.md) (22 onward).
