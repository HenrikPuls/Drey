/**
 * `src/app/assistant` — the note assistant (ADR-0012): `AssistantService`
 * owns the per-note sidecar thread (auto-summary switch, summary / question /
 * answer cards, Ask with running history). The `NoteAssistant` panel body
 * that renders it is deep-imported by `AssistantPanel` in the dock (the one
 * consumer) rather than re-exported here, to keep this barrel — which
 * service-only consumers like `App` pull — free of the component import
 * chain (`MarkdownSurface`, …).
 *
 * This barrel is the module's public surface — code outside the module
 * imports from `../assistant`, never a file inside it (enforced by
 * `eslint.config.mjs`). Files inside the module import their siblings
 * directly.
 */

export { AssistantService } from './assistant.service';
