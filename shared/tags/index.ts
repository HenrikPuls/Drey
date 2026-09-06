/**
 * `shared/tags` — the pure, IPC-crossing tag logic: tag-path / token
 * parsing (with `/` path segments), the `overview.md` layout (free region /
 * marker / Summary / Log), meta-line composition, and the delta / retention
 * selection used by the regeneration cascade.
 *
 * Scaffold only for now. Milestones 11a–11g build into this folder; the old
 * `shared/tag-registry.ts`, `shared/inline-tags.ts` and `shared/history.ts`
 * are removed once their replacements land. This barrel is the module's
 * only public surface — import from `shared/tags`, never a file inside it
 * (enforced by `eslint.config.mjs`).
 */

export {};
