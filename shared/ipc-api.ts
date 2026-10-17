/**
 * Typed IPC contract between the Electron main process and the Angular
 * renderer, exposed via `contextBridge` (see electron/preload.ts).
 *
 * This file is imported by BOTH sides of the boundary -- main (which
 * implements it) and renderer (which consumes it) -- so a mismatch
 * between what main sends and what renderer expects is a compile error,
 * not a runtime surprise. See docs/09_architecture_decisions/0001-*.md.
 *
 * The definitions live in `shared/ipc/`, split by topic; this file is the
 * stable barrel every importer points at (the same shape as
 * `shared/app-config.ts` over `shared/config/`):
 *
 *   - `ipc/channels.ts` -- `IPC_CHANNELS`, the channel names
 *   - `ipc/app.ts`      -- window, exit prompt, Edit menu, logging, startup, config
 *   - `ipc/vault.ts`    -- vault registry, file tree, file IO, link-keeping renames
 *   - `ipc/notes.ts`    -- note save + conflict, drafts, daily notes, PDF export,
 *                          external files, note history, session backups
 *   - `ipc/llm.ts`      -- model list, connection test, debug log, streaming, cancel
 *   - `ipc/tags.ts`     -- tag vocabulary, "Suggest tags"
 *   - `ipc/spelling.ts` -- spellcheck
 *   - `ipc/mcp.ts`      -- the MCP vault server, external tool servers
 *   - `ipc/plugins.ts`  -- plugin discovery, invoke / event, plugin packages
 *   - `ipc/updates.ts`  -- the GitHub-Releases update system (ADR-0074)
 *
 * Each topic file holds its payload types and its slice of the bridge
 * (`AppIpc`, `VaultIpc`, ...); `DreyApi` is their sum. A new channel goes
 * into the topic file it belongs to, never into this one.
 */
import type { AppIpc } from './ipc/app';
import type { LlmIpc } from './ipc/llm';
import type { McpIpc } from './ipc/mcp';
import type { NotesIpc } from './ipc/notes';
import type { PluginsIpc } from './ipc/plugins';
import type { SpellingIpc } from './ipc/spelling';
import type { TagsIpc } from './ipc/tags';
import type { UpdatesIpc } from './ipc/updates';
import type { VaultIpc } from './ipc/vault';

export * from './ipc/channels';
export type * from './ipc/app';
export type * from './ipc/vault';
export type * from './ipc/notes';
export type * from './ipc/llm';
export type * from './ipc/tags';
export type * from './ipc/spelling';
export type * from './ipc/mcp';
export type * from './ipc/plugins';
export type * from './ipc/updates';

export type {
  PluginDescriptorForRenderer,
  PluginIpcEventPayload,
  PluginIpcInvokePayload,
} from './plugin-api/plugin-ipc';

export type { AppConfig, LlmEndpoint, CustomDictionary } from './app-config';
export type { ActionOutcome, LlmCapabilities, LlmDebugEntry } from './llm';

/** The API surface exposed on `window.dreyApi` by the preload script. */
export interface DreyApi
  extends
    AppIpc,
    VaultIpc,
    NotesIpc,
    LlmIpc,
    TagsIpc,
    SpellingIpc,
    McpIpc,
    PluginsIpc,
    UpdatesIpc {}

declare global {
  interface Window {
    dreyApi: DreyApi;
  }
}
