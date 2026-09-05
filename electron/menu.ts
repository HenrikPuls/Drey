import { BrowserWindow, Menu, MenuItemConstructorOptions } from 'electron';

/**
 * Clipboard / editing support for the renderer.
 *
 * Electron *does* ship a default application menu (that's why Ctrl+C/V/X
 * already work in a text field), but the moment any later feature calls
 * `Menu.setApplicationMenu` with its own template, that default -- and its
 * edit roles -- is gone. So we own the menu from here on and always carry
 * the standard edit roles. The bar is auto-hidden on the window
 * (`autoHideMenuBar`, see main.ts) to keep the minimal look; the
 * accelerators stay live regardless of whether the bar is shown.
 *
 * `role`-based items drive the *focused* `webContents` through native
 * editing commands. CodeMirror 6 handles those (it listens for the
 * `cut`/`copy`/`paste` DOM events the native command produces), so this
 * needs nothing in the renderer and nothing crossing the IPC bridge --
 * ADR-0001's boundary stays intact.
 *
 * Undo/redo are deliberately left out: CodeMirror already binds Ctrl+Z /
 * Ctrl+Y through its own history keymap, and routing them through a menu
 * accelerator would intercept the keystroke before CodeMirror sees it
 * without a guarantee the native `historyUndo` reaches CM's history.
 */
export function buildApplicationMenu(): Menu {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    {
      label: '&File',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '&View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '&Window',
      submenu: [{ role: 'minimize' }, isMac ? { role: 'front' } : { role: 'close' }],
    },
  ];

  return Menu.buildFromTemplate(template);
}

/**
 * The right-click menu inside the window. Electron has no default context
 * menu at all, so this is built per-invocation from the hit-test params:
 * full cut/copy/paste/select-all in an editable spot (the CodeMirror
 * editor), just "Copy" when there's a text selection somewhere
 * non-editable (e.g. the rendered Markdown view), and nothing otherwise.
 */
export function attachContextMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', (_event, params) => {
    const { editFlags } = params;
    const hasSelection = params.selectionText.trim().length > 0;

    if (!params.isEditable && !hasSelection) {
      return;
    }

    const template: MenuItemConstructorOptions[] = params.isEditable
      ? [
          { role: 'cut', enabled: editFlags.canCut },
          { role: 'copy', enabled: editFlags.canCopy },
          { role: 'paste', enabled: editFlags.canPaste },
          { type: 'separator' },
          { role: 'selectAll', enabled: editFlags.canSelectAll },
        ]
      : [{ role: 'copy', enabled: editFlags.canCopy }];

    Menu.buildFromTemplate(template).popup({ window });
  });
}
