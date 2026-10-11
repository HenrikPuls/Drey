import { Component, computed, effect, afterNextRender, inject } from '@angular/core';
import { formatDate } from '../../shared/timestamp';
import { ImageLightbox } from './image-viewer';
import { ConfirmationDialog } from './confirmation-dialog/confirmation-dialog';
import { ConfirmDialog } from './confirm-dialog/confirm-dialog';
import { ConflictDialog } from './conflict';
import { ToolApprovalDialog, ToolApprovalService } from './tool-approval';
import { HistoryDialog, HistoryService } from './history';
import { DiffDialog } from './diff-view';
import { LinkUpdateDialog } from './link-update';
import { Palette, PaletteService } from './palette';
import { ExitConfirmDialog } from './exit-confirm-dialog/exit-confirm-dialog';
import { ExternalOpenService } from './external-open';
import { SessionService } from './session';
import { AppearanceService } from './services/appearance.service';
import { ThemeService } from './services/theme.service';
import { DailyNoteService } from './vault';
import { EditorService } from './services/editor.service';
import { ExitConfirmService } from './services/exit-confirm.service';
import { DropGuardService } from './services/drop-guard.service';
import { DocHistoryService } from './services/doc-history.service';
import { EditorZoomService } from './services/editor-zoom.service';
import { LogService } from './services/log.service';
import { McpBridgeService } from './services/mcp-bridge.service';
import { PaneLayout, PaneService } from './panes';
import { SettingsService } from './services/settings.service';
import { AboutService } from './services/about.service';
import { VaultService } from './vault';
import { KeybindingService } from './keybindings';
import { Dock, DockService } from './dock';
import { Titlebar } from './titlebar';
import { WindowChromeService } from './titlebar';
import { StatusBar } from './status-bar/status-bar';
import { Settings } from './settings/settings';
import { EditorContextMenu } from './editor-context-menu/editor-context-menu';
import { EditorContextMenuService } from './editor-context-menu/editor-context-menu.service';
import { EditorContextMenuRegistry } from './plugin-host';

/**
 * Root shell (ADR-0019): a custom titlebar with the HTML menu bar, then a
 * row of [left dock | main column | right dock], then a status bar. Panels
 * (calendar, files, search, open windows, assistant) live in the docks and
 * are opened/closed from each dock's icon strip and dragged/resized via
 * `DockService`.
 *
 * The centre column is a tab bar + editor (once at least one document is
 * open) above the bottom dock (empty by default). Quick-capture (`DailyNoteService`) wires the Ctrl+Alt+N hotkey
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
    LinkUpdateDialog,
    ConflictDialog,
    ToolApprovalDialog,
    HistoryDialog,
    DiffDialog,
    Palette,
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

  /**
   * A folded side dock is out of the layout -- except during a panel drag,
   * when it shows like an empty dock does, so it can still be dropped into.
   */
  protected folded(side: 'left' | 'right'): boolean {
    return this.dock.sideFolded(side) && !this.dock.dragActive();
  }
  protected readonly panes = inject(PaneService);
  private readonly vault = inject(VaultService);
  private readonly fileHistory = inject(HistoryService);

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
    // Document history (back/forward, Alt+Arrow): recording starts
    // SUSPENDED -- the startup flows below mass-open tabs (session
    // restore, OS-collected files, the daily-note fallback) and none of
    // that churn is navigation. Resumed with a seed of whatever document
    // the user actually landed on.
    const history = inject(DocHistoryService);
    history.suspend();

    // Subscribe to the quick-capture hotkey for the app's lifetime.
    inject(DailyNoteService).start();
    // Files the OS hands to Drey (Explorer "Open with", ADR-0054): later
    // launches arrive as a push; the launch's own files are pulled below,
    // once startup has settled.
    const externalOpen = inject(ExternalOpenService);
    externalOpen.start();
    // Instantiate at startup so its global Ctrl+wheel guard is installed
    // even before the first document (and its editor) opens (ADR-0015).
    inject(EditorZoomService);

    // Native window title (`Drey — <branch>`): identifies the checkout /
    // worktree this instance was built from -- read by the taskbar and
    // Alt-Tab, never shown by the custom titlebar itself.
    void inject(AboutService).applyWindowTitle();
    // Mirror uncaught renderer errors + rejections into the log file (ADR-0032).
    inject(LogService).install();

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
    // External tool calls that need the user's approval (ADR-0063).
    inject(ToolApprovalService).start();
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
      // No active vault: nothing to restore, but a file the OS handed to Drey
      // still opens (as an external tab, ADR-0054).
      if (loaded && this.vault.registryLoaded() && !vaultPath) {
        void externalOpen.onStartupSettled().then(() => {
          history.resume();
          // The ADR-0062 handover: main shows the (hidden) main window and
          // closes the splash. Optional-chained: harmless without a bridge.
          window.dreyApi?.reportStartupReady?.();
        });
      }
      if (this.dailyNoteStartupDone || !vaultPath || !loaded) {
        return;
      }
      this.dailyNoteStartupDone = true;
      void (async () => {
        // The splash's activity line while the tabs come back.
        window.dreyApi?.reportStartupProgress?.({ label: 'Restoring session…', pct: 92 });
        const restored = await session.restore();
        // After the restore, so the OS-opened file lands active on top of it.
        // A launch that opened a file also skips the daily-note fallback --
        // that async open would otherwise land last and steal the focus.
        const openedFromOs = await externalOpen.onStartupSettled();
        if (!restored && openedFromOs === 0 && this.settings.dailyOpenOnStartup()) {
          // Awaited so the window the splash hands over to already carries
          // the daily note instead of gaining it a beat later.
          await this.editor.openDailyNote(formatDate(new Date()));
        }
        history.resume();
        window.dreyApi?.reportStartupReady?.();
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

    // Back / forward through the session's document history (the titlebar
    // arrows, View menu, and the mouse side buttons). `ArrowLeft`/`ArrowRight`
    // spell out the `KeyboardEvent.key` ("arrowleft" after lower-casing);
    // this shadows CodeMirror's Alt+Arrow subword steps, accepted for the
    // browser-standard chord. The side buttons (XButton1/2) ride
    // `mouseButton` — VS Code-style, window-wide.
    keys.register({
      id: 'doc.back',
      label: 'Go back',
      keybinding: 'Alt+ArrowLeft',
      mouseButton: 3,
      run: () => void history.back(),
    });
    keys.register({
      id: 'doc.forward',
      label: 'Go forward',
      keybinding: 'Alt+ArrowRight',
      mouseButton: 4,
      run: () => void history.forward(),
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

    // Fold a whole side dock away (the titlebar toggles + View menu rows).
    keys.register({
      id: 'dock.toggleLeft',
      label: 'Toggle left dock',
      keybinding: 'Mod+B',
      run: () => this.dock.toggleSide('left'),
    });
    keys.register({
      id: 'dock.toggleRight',
      label: 'Toggle right dock',
      keybinding: 'Mod+Alt+B',
      run: () => this.dock.toggleSide('right'),
    });

    // OS fullscreen (the View menu's "Full screen" row shares the id). F11
    // must stay renderer-owned: the old native `togglefullscreen` menu role
    // swallowed the key in main before the command could see it.
    const windowChrome = inject(WindowChromeService);
    keys.register({
      id: 'window.toggleFullScreen',
      label: 'Toggle full screen',
      keybinding: 'F11',
      run: () => windowChrome.toggleFullScreen(),
    });

    // The quick switcher / command palette (milestone 59): one overlay,
    // opened on its file list or -- with a leading `>` -- its command list.
    const palette = inject(PaletteService);
    keys.register({
      id: 'palette.files',
      label: 'Go to file…',
      keybinding: 'Mod+P',
      run: () => palette.show('files'),
    });
    keys.register({
      id: 'palette.commands',
      label: 'Command palette…',
      keybinding: 'Mod+Shift+P',
      run: () => palette.show('commands'),
    });

    // Actions that so far lived only in a menu row or a button -- registered
    // as commands so the palette can list them.
    keys.register({
      id: 'settings.open',
      label: 'Open settings',
      keybinding: 'Mod+,',
      run: () => {
        // Re-opening would re-seed the draft and drop unsaved changes.
        if (!this.settings.screenOpen()) {
          this.settings.openScreen();
        }
      },
    });
    keys.register({
      id: 'layout.reset',
      label: 'Reset layout',
      run: () => {
        this.dock.reset();
        this.panes.resetRegions();
      },
    });
    keys.register({
      id: 'vault.refresh',
      label: 'Refresh vault',
      run: () => void this.vault.refresh(),
    });
    keys.register({
      id: 'daily.today',
      label: 'Open today’s daily note',
      run: () => void this.editor.openDailyNote(formatDate(new Date())),
    });
    keys.register({
      id: 'editor.toggleSource',
      label: 'Toggle source mode',
      run: () => {
        if (this.editor.activeKind() === 'text' && this.editor.isMarkdown(this.editor.activePath())) {
          this.editor.setViewMode(this.editor.viewMode() === 'source' ? 'live' : 'source');
        }
      },
    });
    keys.register({
      id: 'note.exportPdf',
      label: 'Export as PDF…',
      run: () => {
        if (this.editor.activeKind() === 'text' && this.editor.isMarkdown(this.editor.activePath())) {
          void this.editor.exportPdf();
        }
      },
    });
    keys.register({
      id: 'note.history',
      label: 'File history…',
      run: () => void this.fileHistory.show(),
    });

    // Startup mark (milestone 61): the first paint of the app shell —
    // everything before this line in the log was pre-paint cost. Also the
    // splash's "workspace" stage (milestone 62): the hidden window has
    // painted, the session follows.
    const startupLog = inject(LogService);
    afterNextRender(() => {
      startupLog.record(
        'info',
        `[startup] renderer: shell painted +${Math.round(performance.now())}ms since navigation start`,
      );
      window.dreyApi?.reportStartupProgress?.({ label: 'Preparing workspace', pct: 85 });
    });
  }
}
