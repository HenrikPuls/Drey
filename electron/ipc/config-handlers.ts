import { ipcMain } from 'electron';
import {
  AppConfig,
  CaptureHotkeyStatus,
  GlobalChord,
  GlobalShortcutStatus,
  IPC_CHANNELS,
} from '../../shared/ipc-api';
import { chordToAccelerator } from '../../shared/keybindings';
import { AppConfigStore } from '../app-config';
import { CaptureHotkey } from '../capture-hotkey';
import { GlobalShortcuts } from '../global-shortcuts';
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
  /** The system-wide chords of global plugin commands (SDK 1.37, req-75 W5a). */
  globalShortcuts: GlobalShortcuts;
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
  globalShortcuts,
}: ConfigHandlerDeps): void {
  ipcMain.handle(IPC_CHANNELS.configGet, (): AppConfig => appConfig.get());
  ipcMain.handle(IPC_CHANNELS.captureHotkeyStatus, (): CaptureHotkeyStatus => captureHotkey.status());
  // The renderer pushes the global commands' chords; the quick-capture
  // accelerator is reserved, so the two can never fight over one combo.
  ipcMain.handle(
    IPC_CHANNELS.globalShortcutsSync,
    (_event, payload: unknown): GlobalShortcutStatus[] => {
      const chords = parseGlobalChords(payload);
      const captureChord = captureHotkey.status().chord;
      const reserved =
        captureChord === null
          ? []
          : [chordToAccelerator(captureChord)].filter(
              (accelerator): accelerator is string => accelerator !== null,
            );
      return globalShortcuts.sync(chords, reserved);
    },
  );
  // The confirmation dialog's per-trigger "don't ask again": a narrow
  // write into the assistant plugin's own config, where the triggers
  // live since the ADR-0010 later change. NOT the whole-config
  // `config:set` — that payload no longer carries actions at all.
  ipcMain.handle(
    IPC_CHANNELS.configSetTriggerConfirm,
    async (_event, triggerId: unknown, confirm: unknown): Promise<void> => {
      if (typeof triggerId !== 'string' || typeof confirm !== 'boolean') {
        throw new Error('malformed trigger-confirm payload');
      }
      const actions = await pluginHost.readActionsConfig();
      await pluginHost.writePluginConfig('assistant', 'actions', {
        ...actions,
        triggers: actions.triggers.map((trigger) =>
          trigger.id === triggerId ? { ...trigger, confirm } : trigger,
        ),
      });
    },
  );
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

/**
 * The `globalShortcutsSync` payload as `GlobalChord`s: an array of
 * `{ id: string, chord: string }`; anything else yields the empty list
 * (an unknown id simply registers nothing — the renderer owns the ids).
 */
function parseGlobalChords(payload: unknown): GlobalChord[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload.flatMap((entry): GlobalChord[] => {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { id?: unknown }).id === 'string' &&
      typeof (entry as { chord?: unknown }).chord === 'string'
    ) {
      return [{ id: (entry as { id: string }).id, chord: (entry as { chord: string }).chord }];
    }
    return [];
  });
}
