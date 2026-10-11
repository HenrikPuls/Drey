/**
 * The base IPC channel names -- the one runtime value of the contract
 * (`shared/ipc-api.ts` is the barrel).
 */

/**
 * Channel names. Most are `ipcMain.handle` / `ipcRenderer.invoke` request
 * pairs; `dailyOpen` is the first main -> renderer push
 * (`webContents.send` / `ipcRenderer.on`) -- fired by the quick-capture
 * hotkey to tell the renderer which file to open.
 */
export const IPC_CHANNELS = {
  getAppInfo: 'app:get-info',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  exitConfirmRequest: 'exit:confirm-request',
  exitDecision: 'exit:decision',
  exitListenerReady: 'exit:listener-ready',
  windowIsMaximized: 'window:is-maximized',
  windowMaximizeChanged: 'window:maximize-changed',
  windowToggleFullScreen: 'window:toggle-fullscreen',
  windowIsFullScreen: 'window:is-fullscreen',
  windowFullScreenChanged: 'window:fullscreen-changed',
  editExec: 'edit:exec',
  uiSetZoom: 'ui:set-zoom',
  openExternal: 'app:open-external',
  openLocalDocument: 'app:open-local-document',
  appLog: 'app:log',
  // Startup splash (milestone 62): renderer stage reports + the one-shot
  // "workspace ready" that triggers the hidden-until-ready handover.
  startupProgress: 'startup:progress',
  startupReady: 'startup:ready',
  vaultGetActive: 'vault:get-active',
  // Multi-vault registry (ADR-0051): the vaults the app knows about, one
  // native-picker add, registry-only remove, display-name rename, explicit
  // active switch, and a shell reveal of the folder. `vault:select` (the
  // old picker-overwrite switch) is gone -- switching is `set-active`.
  vaultList: 'vault:list',
  vaultAdd: 'vault:add',
  vaultRemove: 'vault:remove',
  vaultRenameVault: 'vault:rename-vault',
  vaultSetActive: 'vault:set-active',
  vaultRevealFolder: 'vault:reveal-folder',
  vaultRevealPath: 'vault:reveal-path',
  vaultOpenInTerminal: 'vault:open-in-terminal',
  vaultOpenExternally: 'vault:open-externally',
  vaultGetActiveId: 'vault:get-active-id',
  vaultListFiles: 'vault:list-files',
  vaultReadFile: 'vault:read-file',
  vaultWriteFile: 'vault:write-file',
  vaultWriteBinary: 'vault:write-binary',
  vaultReadBinary: 'vault:read-binary',
  vaultSaveAsset: 'vault:save-asset',
  vaultSaveAssetFromUrl: 'vault:save-asset-from-url',
  vaultCreateFile: 'vault:create-file',
  vaultCreateDirectory: 'vault:create-directory',
  vaultRename: 'vault:rename-entry',
  // Milestone 59 (ADR-0059): the rename that keeps links intact -- a
  // preview of the affected notes / attachments, and the rename that
  // carries the plan out.
  vaultRenamePreview: 'vault:rename-preview',
  vaultRenameWithLinks: 'vault:rename-with-links',
  vaultCopy: 'vault:copy-entry',
  vaultDuplicate: 'vault:duplicate-entry',
  vaultDelete: 'vault:delete',
  vaultDeleteMany: 'vault:delete-many',
  vaultRefresh: 'vault:refresh',
  draftSave: 'draft:save',
  vaultPickSavePath: 'vault:pick-save-path',
  dailyOpen: 'daily:open',
  // Files the OS hands to Drey (Explorer "Open with" / default program,
  // ADR-0054). `external:take-pending` is the renderer's cold-start PULL of
  // whatever the launch argv carried; `external:open-request` is the PUSH for
  // every later launch (`second-instance`); `external:read` reads one file
  // main itself collected from the OS -- never an arbitrary renderer path;
  // `external:write` saves back to exactly such a path, same allowlist.
  externalTakePending: 'external:take-pending',
  externalRead: 'external:read',
  externalWrite: 'external:write',
  externalOpenRequest: 'external:open-request',
  dailyBuildContent: 'daily:build-content',
  noteSave: 'note:save',
  exportNotePdf: 'export:note-pdf',
  tagSuggest: 'tags:suggest',
  // Tag vocabulary + prefix styles over the section-search provider (the
  // tags plugin registers it; ADR-0017/ADR-0044). `search:vocabulary` is a
  // request the base renderer makes; it degrades to an empty payload when
  // no provider is registered. `search:changed` is the main -> renderer
  // push fired whenever the provider or its index changed.
  searchVocabulary: 'search:vocabulary',
  searchChanged: 'search:changed',
  configGet: 'config:get',
  configSet: 'config:set',
  llmListModels: 'llm:list-models',
  llmTestConnection: 'llm:test-connection',
  llmDebugList: 'llm:debug-list',
  llmDebugClear: 'llm:debug-clear',
  llmDebugEntry: 'llm:debug-entry',
  llmDelta: 'llm:delta',
  llmCancel: 'llm:cancel',
  llmCapabilitiesChanged: 'llm:capabilities-changed',
  spellCheck: 'spell:check',
  spellSuggest: 'spell:suggest',
  spellLanguages: 'spell:languages',
  spellAddDictionary: 'spell:add-dictionary',
  spellAddWord: 'spell:add-word',
  // MCP vault server (ADR-0021).
  mcpStatus: 'mcp:status',
  mcpWriteRequest: 'mcp:write-request',
  mcpWriteDecision: 'mcp:write-decision',
  // The assistant's external tools (milestone 63, ADR-0063).
  toolsStatus: 'tools:status',
  toolsReconnect: 'tools:reconnect',
  toolsApprovalRequest: 'tools:approval-request',
  toolsApprovalDecision: 'tools:approval-decision',
  // Vault change push (ADR-0045): main -> renderer after any external or
  // MCP write lands -- formerly the MCP-only 'mcp:vault-changed'. Carries
  // the changed paths when a scoped reload is possible.
  vaultChanged: 'vault:changed',
  // Session history (ADR-0043): a backup store under the user-data dir for
  // the text of tabs that have no file on disk (or unsaved edits), so they
  // survive a restart. The layout / tab list itself lives in the
  // renderer's localStorage, like the dock layout.
  // Local note history (milestone 60, ADR-0060).
  historyList: 'history:list',
  historyRead: 'history:read',
  historyCapture: 'history:capture',
  sessionWriteBackup: 'session:write-backup',
  sessionReadBackup: 'session:read-backup',
  sessionListBackups: 'session:list-backups',
  sessionDeleteBackups: 'session:delete-backups',
  // Plugin host (ADR-0044). Two FIXED channels, not per-plugin names: the
  // invoke payload carries { pluginId, method, payload } and main routes it
  // to that plugin's registered method allowlist; events fan out
  // renderer-side. pluginList is the discovery report for Settings.
  pluginInvoke: 'plugin:invoke',
  pluginEvent: 'plugin:event', // push main -> renderer
  pluginList: 'plugin:list',
  // Local plugin packages (ADR-0068): pick + install + remove, separate
  // channels so the install step is testable without driving the native
  // dialog. Changes apply on the next start — like `plugins.disabled`.
  pluginPickPackage: 'plugin:pick-package',
  pluginInstallPackage: 'plugin:install-package',
  pluginUninstall: 'plugin:uninstall',
  appRelaunch: 'app:relaunch',
} as const;
