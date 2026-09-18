import { Component, computed, effect, inject } from '@angular/core';
import { formatDate } from '../../shared/timestamp';
import { ImageLightbox } from './image-viewer';
import { ConfirmationDialog } from './confirmation-dialog/confirmation-dialog';
import { ConfirmDialog } from './confirm-dialog/confirm-dialog';
import { ExitConfirmDialog } from './exit-confirm-dialog/exit-confirm-dialog';
import { SessionService } from './session';
import { AppearanceService } from './services/appearance.service';
import { ThemeService } from './services/theme.service';
import { DailyNoteService } from './vault';
import { EditorService } from './services/editor.service';
import { ExitConfirmService } from './services/exit-confirm.service';
import { DropGuardService } from './services/drop-guard.service';
import { EditorZoomService } from './services/editor-zoom.service';
import { InputRecoveryService } from './services/input-recovery.service';
import { LogService } from './services/log.service';
import { McpBridgeService } from './services/mcp-bridge.service';
import { PaneLayout, PaneService } from './panes';
import { SettingsService } from './services/settings.service';
import { VaultService } from './vault';
import { KeybindingService } from './keybindings';
import { Dock, DockService } from './dock';
import { Titlebar } from './titlebar';
import { StatusBar } from './status-bar/status-bar';
import { Settings } from './settings/settings';
import { EditorContextMenu } from './editor-context-menu/editor-context-menu';
import { EditorContextMenuService } from './editor-context-menu/editor-context-menu.service';
import { EditorContextMenuRegistry } from './plugin-host';

/**
 * Root shell (ADR-0019): a custom titlebar with the HTML menu bar, then a
 * row of [left dock | main column | right dock], then a status bar. Panels
 * (calendar, files, search, open windows, assistant) live in the two docks
 * and are dragged/resized/collapsed via `DockService`.
 *
 * The centre column is a tab bar + editor (once at least one document is
 * open) above the bottom dock (which hosts the "Add entry" panel by
 * default). Quick-capture (`DailyNoteService`) wires the Ctrl+Alt+N hotkey
 * for the app's lifetime. Every pane resize is now a `DockService` edge /
 * splitter gesture -- `App` holds no imperative drag code.
 */
@Component({
  selector: 'app-root',
  imports: [
    Titlebar,
    Dock,
    StatusBar,
    PaneLayout,
    Settings,
    ConfirmationDialog,
    ConfirmDialog,
    ExitConfirmDialog,
    ImageLightbox,
    EditorContextMenu,
  ],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly ipcAvailable = typeof window !== 'undefined' && !!window.dreyApi;
  protected readonly editor = inject(EditorService);
  protected readonly settings = inject(SettingsService);
  protected readonly dock = inject(DockService);
  protected readonly panes = inject(PaneService);
  private readonly vault = inject(VaultService);

  /** The pane docked in each dock's editor band -- extends the dock render gates beyond widgets. */

  /** Guards the one-shot "open today's daily note on startup" effect. */
  private dailyNoteStartupDone = false;

  /** Moves editor focus to the next (`+1`) / previous (`-1`) pane, wrapping. */
  private stepPaneFocus(dir: 1 | -1): void {
    const ids = this.panes.paneIds();
    if (ids.length < 2) {
      return;
    }
    const at = Math.max(0, ids.indexOf(this.panes.focusedId()));
    this.panes.focus(ids[(at + dir + ids.length) % ids.length]);
  }

  constructor() {
    // Subscribe to the quick-capture hotkey for the app's lifetime.
    inject(DailyNoteService).start();
    // Instantiate at startup so its global Ctrl+wheel guard is installed
    // even before the first document (and its editor) opens (ADR-0015).
    inject(EditorZoomService);
    // Mirror uncaught renderer errors + rejections into the log file (ADR-0032).
    inject(LogService).install();
    // Manual "unstick the keyboard" escape hatch + watchdog (ADR-0032).
    const recovery = inject(InputRecoveryService);
    recovery.startWatchdog();

    // Install the window-level drag/drop navigation guard (ADR-0027).
    inject(DropGuardService);
    // Instantiate so the selected theme's shell palette is applied on
    // startup and kept in sync (the editor swaps its own CM theme).
    inject(ThemeService);
    // Instantiate so the app-wide accent + UI scale from Settings ->
    // Appearance are applied on startup and kept in sync.
    inject(AppearanceService);
    // Listen for MCP client write-confirmations / vault-changed pushes (ADR-0021).
    inject(McpBridgeService).start();
    // Answer main's save-before-exit question (bug-5) and show the dialog
    // when there are dirty documents.
    inject(ExitConfirmService).start();
    // Install the capture-phase contextmenu listener that gives the editor
    // its own right-click menu in place of the OS one (ADR-0030).
    inject(EditorContextMenuService).start();
    // "Export as PDF…" in that right-click menu. The base registers through
    // the same registry plugins use (ADR-0044 rule 2); scoped to pane text
    // documents that are Markdown, exactly like the `⋯`-menu row. The
    // target's `docPath` is the editor host's doc KEY (`shownPath()`), so
    // `exportPdf` resolves it directly. `head: true` keeps it in the base
    // group above the plugin rows (req-34: templates are last).
    inject(EditorContextMenuRegistry).register(
      (target) => {
        if (target.surface !== 'editor' || target.docPath === null || !this.editor.isMarkdown(target.docPath)) {
          return [];
        }
        const docKey = target.docPath;
        return [{ label: 'Export as PDF…', run: () => void this.editor.exportPdf(docKey) }];
      },
      { head: true },
    );

    // Startup, once, after both the vault path and the persisted config are
    // known: restore the previous session's layout + tabs (ADR-0043), then
    // fall back to opening today's daily note only if nothing was restored.
    // `vault.refresh()` re-runs after saves, so the boolean guard (not just
    // the signal) keeps this to a single pass.
    const session = inject(SessionService);
    effect(() => {
      const vaultPath = this.vault.activeVaultPath();
      const loaded = this.settings.loaded();
      if (this.dailyNoteStartupDone || !vaultPath || !loaded) {
        return;
      }
      this.dailyNoteStartupDone = true;
      void (async () => {
        const restored = await session.restore();
        if (!restored && this.settings.dailyOpenOnStartup()) {
          void this.editor.openDailyNote(formatDate(new Date()));
        }
      })();
    });

    // App-wide keyboard commands. Features register here the same way; the
    // titlebar menu bar invokes the same command ids.
    const keys = inject(KeybindingService);
    keys.register({
      id: 'note.new',
      label: 'New note',
      keybinding: 'Mod+N',
      run: () => this.editor.newUntitled(),
    });
    keys.register({
      id: 'note.save',
      label: 'Save',
      keybinding: 'Mod+S',
      run: () => void this.editor.save(),
    });
    keys.register({
      id: 'note.saveAs',
      label: 'Save as…',
      keybinding: 'Mod+Shift+S',
      run: () => void this.editor.saveAs(),
    });
    keys.register({
      id: 'note.saveAll',
      label: 'Save all',
      keybinding: 'Mod+Alt+S',
      run: () => void this.editor.saveAll(),
    });
    keys.register({
      id: 'editor.toggleLineNumbers',
      label: 'Toggle line numbers',
      keybinding: 'Mod+G',
      run: () => this.editor.toggleLineNumbers(),
    });

    // Split-view panes (ADR-0037). The layout mechanics already exist
    // (PaneService + the tab context menu); these are the keyboard / menu
    // entry points. Chords avoid `Alt+Arrow` (move line) and a bare `\`
    // (AltGr on a German layout).
    keys.register({
      id: 'pane.splitRight',
      label: 'Split editor right',
      keybinding: 'Mod+Alt+Enter',
      run: () =>
        this.panes.splitPane(this.panes.focusedId(), 'row', this.editor.activePath() ?? undefined),
    });
    keys.register({
      id: 'pane.splitDown',
      label: 'Split editor down',
      keybinding: 'Mod+Alt+Shift+Enter',
      run: () =>
        this.panes.splitPane(
          this.panes.focusedId(),
          'column',
          this.editor.activePath() ?? undefined,
        ),
    });
    keys.register({
      id: 'pane.focusNext',
      label: 'Focus next pane',
      keybinding: 'F6',
      run: () => this.stepPaneFocus(1),
    });
    keys.register({
      id: 'pane.focusPrev',
      label: 'Focus previous pane',
      keybinding: 'Shift+F6',
      run: () => this.stepPaneFocus(-1),
    });

    keys.register({
      id: 'input.recover',
      label: 'Recover input focus',
      keybinding: 'Mod+Alt+Shift+R',
      run: () => recovery.recover('manual'),
    });
  }
}
