import { BrowserWindow, Menu, MenuItemConstructorOptions } from 'electron';
import { logLine } from './logger';

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
        // No window-zoom items here on purpose. Ctrl +/-/0 is handled in
        // the renderer and scales the editor *content* only, not the whole
        // window (ADR-0015). Menu accelerators would swallow those keys
        // before the renderer ever saw them. The same applies to the old
        // `togglefullscreen` role: its default F11 accelerator would eat
        // the key before the renderer's `window.toggleFullscreen` command
        // (the View-menu row) could handle it -- fullscreen lives entirely
        // in the renderer now (window:toggle-fullscreen IPC).
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
 * full cut/copy/paste/select-all in a native editable field (`<input>` /
 * `<textarea>` in Settings, the entry topic), just "Copy" when there's a
 * text selection somewhere non-editable (e.g. the rendered Markdown view),
 * and nothing otherwise.
 *
 * The CodeMirror editing surface is deliberately skipped: it is
 * `contenteditable`, which Chromium reports as `isEditable === true` but
 * `formControlType === 'none'` (a real `<input>` is `'input-text'`, a
 * `<textarea>` is `'text-area'`), and the renderer draws its own
 * right-click menu there (ADR-0030).
 */
export function attachContextMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', (_event, params) => {
    const { editFlags } = params;
    const hasSelection = params.selectionText.trim().length > 0;

    if (!params.isEditable && !hasSelection) {
      return;
    }

    // CodeMirror's contenteditable surface -> the renderer owns the menu.
    if (params.isEditable && params.formControlType === 'none') {
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

    popupTracked(window, Menu.buildFromTemplate(template));
  });

  // Bug-6 hardening: if a popup's capture loop never unwinds, it swallows
  // every keystroke while the mouse keeps working. Losing window focus is
  // the moment a native popup has no reason to stay open.
  window.on('blur', () => closeTrackedPopups(window, 'window blur'));
  window.on('minimize', () => closeTrackedPopups(window, 'window minimize'));
}

/**
 * The context menus currently popped over each window. A native popup whose
 * capture loop never unwinds is invisible but swallows all keyboard input --
 * the leading suspect for the packaged build's stuck-input state (bug-6),
 * which the renderer can neither see nor fix. Tracking them here gives main
 * an escape hatch: `closePopup` on blur / on the renderer's "recover input"
 * command, and a log trace a field occurrence finally leaves behind.
 */
const trackedPopups = new Map<BrowserWindow, Menu>();

function popupTracked(window: BrowserWindow, menu: Menu): void {
  // A window tracks one popup at a time; a stale entry (close event missed)
  // is simply replaced.
  trackedPopups.set(window, menu);
  menu.once('menu-will-close', () => {
    if (trackedPopups.get(window) === menu) {
      trackedPopups.delete(window);
    }
  });
  logLine('[main/context-menu] popup opened');
  menu.popup({ window });
}

/**
 * Closes any context menu still popped over `window` (no-op when none).
 * Returns `true` when one was actually closed -- the recover-input handler
 * logs that, so a stuck-input session shows whether this was the culprit.
 */
export function closeTrackedPopups(window: BrowserWindow, reason: string): boolean {
  const menu = trackedPopups.get(window);
  if (!menu) {
    return false;
  }
  trackedPopups.delete(window);
  try {
    menu.closePopup(window);
    logLine(`[main/context-menu] closed a still-tracked popup (${reason})`);
    return true;
  } catch (err) {
    logLine(`[main/context-menu] closePopup failed (${reason}): ${String(err)}`);
    return false;
  }
}
