/**
 * App-level configuration -- the LLM connection, the Actions system
 * (prompt templates + trigger mappings), Appearance, Spelling, and the
 * other Settings categories.
 *
 * This is *application* configuration, not vault content. It is stored in a
 * single JSON file under Electron's `userData` directory
 * (`electron/app-config.ts`), independent of which vault is open, and is
 * never written into the vault as Markdown. See
 * `docs/09_architecture_decisions/0010-app-settings-storage.md`.
 *
 * The definitions live in `shared/config/`, split by concern; this file is
 * the stable barrel every importer already points at:
 *
 *   - `config/schema.ts`    -- the `interface` / `type` shapes + constant data
 *   - `config/defaults.ts`  -- `DEFAULT_APP_CONFIG` + the built-in template factories
 *   - `config/normalize.ts` -- `normalizeAppConfig` + the pure value helpers
 *
 * Imported by BOTH sides of the IPC boundary -- the main process owns the
 * file, the renderer's Settings screen edits it through `config:get` /
 * `config:set` -- so the shape lives here once, the same rule as
 * `shared/ipc-api.ts`.
 */

export * from './config/schema';
export * from './config/defaults';
export * from './config/normalize';
