import { ipcMain } from 'electron';
import { AppConfig, CaptureHotkeyStatus, IPC_CHANNELS } from '../../shared/ipc-api';
import { AppConfigStore } from '../app-config';
import { CaptureHotkey } from '../capture-hotkey';
import { PluginHost } from '../plugin-host';
import { SpellcheckService } from '../spellcheck';

export interface ConfigHandlerDeps {
  appConfig: AppConfigStore;
  spellcheck: SpellcheckService;
  pluginHost: PluginHost;
  /** Opens / closes the localhost MCP HTTP endpoint to match the stored config. */
  syncMcpHttp: () => Promise<void>;
  /** Connects / drops the external MCP servers to match the stored config (ADR-0063). */
  syncMcpClients: () => void;
  /** Starts / stops the vault watcher to match the stored config (ADR-0045). */
  syncVaultWatcher: () => Promise<void>;
  /** Sets the window / taskbar icon that goes with the stored theme (req-42). */
  syncWindowIcon: () => void;
  /** The system-wide quick-capture hotkey (ADR-0073). */
  captureHotkey: CaptureHotkey;
}

/** `config:get` / `config:set`, with the side effects a saved config triggers. */
export function registerConfigHandlers({
  appConfig,
  spellcheck,
  pluginHost,
  syncMcpHttp,
  syncMcpClients,
  syncVaultWatcher,
  syncWindowIcon,
  captureHotkey,
}: ConfigHandlerDeps): void {
  ipcMain.handle(IPC_CHANNELS.configGet, (): AppConfig => appConfig.get());
  ipcMain.handle(IPC_CHANNELS.captureHotkeyStatus, (): CaptureHotkeyStatus => captureHotkey.status());
  ipcMain.handle(IPC_CHANNELS.configSet, async (_event, next: AppConfig): Promise<AppConfig> => {
    const prevTemplatesDir = appConfig.get().templates.dir;
    const prevTheme = appConfig.get().appearance.theme;
    const stored = appConfig.set(next);
    if (stored.appearance.theme !== prevTheme) {
      syncWindowIcon();
    }
    // A no-op unless the chord changed or the last registration failed.
    captureHotkey.sync(stored.keybindings.capture);
    // The language or a dictionary path may have changed; the next check
    // reloads rather than answering from a stale dictionary.
    spellcheck.invalidate();
    // The MCP block may have flipped -- open/close the HTTP endpoint to match.
    await syncMcpHttp();
    syncMcpClients();
    // The vault watch switch may have flipped -- start/stop to match.
    await syncVaultWatcher();
    // A changed templates folder shifts which files the plugins' indexes
    // exclude -- they rebuild from the vault-change event, and the renderer
    // picks the new data up on its next refresh.
    if (stored.templates.dir !== prevTemplatesDir) {
      pluginHost.emitVaultChange({ kind: 'refresh' });
    }
    return stored;
  });
}
