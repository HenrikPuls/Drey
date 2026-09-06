/**
 * `electron/tags` — the main-process side of the path-based tag system:
 * the tag-path index, deterministic tag apply / overview-log append,
 * `overview.md` regeneration with the delta cascade, and `ensureFolderPath`.
 *
 * Scaffold only for now. Milestones 11a–11g build into this folder and the
 * old `electron/tag-index.ts` is removed once its replacement lands. This
 * barrel is the module's only public surface — import from `./tags`, never
 * a file inside it (enforced by `eslint.config.mjs`).
 */

export {};
