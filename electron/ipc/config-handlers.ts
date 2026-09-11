import { ipcMain } from 'electron';
import { AppConfig, IPC_CHANNELS } from '../../shared/ipc-api';
import { AppConfigStore } from '../app-config';
import { PluginHost } from '../plugin-host';
import { SpellcheckService } from '../spellcheck';

export interface ConfigHandlerDeps {
  appConfig: AppConfigStore;
  spellcheck: SpellcheckService;
  pluginHost: PluginHost;
  /** Opens / closes the localhost MCP HTTP endpoint to match the stored config. */
  syncMcpHttp: () => Promise<void>;
}

/** `config:get` / `config:set`, with the side effects a saved config triggers. */
export function registerConfigHandlers({
  appConfig,
  spellcheck,
  pluginHost,
  syncMcpHttp,
}: ConfigHandlerDeps): void {
  ipcMain.handle(IPC_CHANNELS.configGet, (): AppConfig => appConfig.get());
  ipcMain.handle(IPC_CHANNELS.configSet, async (_event, next: AppConfig): Promise<AppConfig> => {
    const prevTemplatesDir = appConfig.get().templates.dir;
    const stored = appConfig.set(next);
    // The language or a dictionary path may have changed; the next check
    // reloads rather than answering from a stale dictionary.
    spellcheck.invalidate();
    // The MCP block may have flipped -- open/close the HTTP endpoint to match.
    await syncMcpHttp();
    // A changed templates folder shifts which files the plugins' indexes
    // exclude -- they rebuild from the vault-change event, and the renderer
    // picks the new data up on its next refresh.
    if (stored.templates.dir !== prevTemplatesDir) {
      pluginHost.emitVaultChange({ kind: 'refresh' });
    }
    return stored;
  });
}
