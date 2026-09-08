import { Component, effect, inject } from '@angular/core';
import { formatDate } from '../../shared/timestamp';
import { Editor } from './editor/editor';
import { ImageLightbox, ImageTab } from './image-viewer';
import { ConfirmationDialog } from './confirmation-dialog/confirmation-dialog';
import { ActionsService } from './services/actions.service';
import { AppearanceService } from './services/appearance.service';
import { AssistantService } from './services/assistant.service';
import { DailyNoteService } from './services/daily-note.service';
import { EditorService } from './services/editor.service';
import { DropGuardService } from './services/drop-guard.service';
import { EditorZoomService } from './services/editor-zoom.service';
import { InputRecoveryService } from './services/input-recovery.service';
import { LogService } from './services/log.service';
import { McpBridgeService } from './services/mcp-bridge.service';
import { SettingsService } from './services/settings.service';
import { VaultService } from './services/vault.service';
import { KeybindingService } from './keybindings';
import { TagSearchService } from './tags';
import { Dock, DockService } from './dock';
import { Titlebar } from './titlebar';
import { StatusBar } from './status-bar/status-bar';
import { Settings } from './settings/settings';
import { TabBar } from './tab-bar/tab-bar';
import {
  EditorContextMenu,
  EditorContextMenuService,
  TemplateLibraryService,
  TemplatePicker,
} from './templates';

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
    TabBar,
    Editor,
    ImageTab,
    Settings,
    ConfirmationDialog,
    ImageLightbox,
    TemplatePicker,
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
  private readonly vault = inject(VaultService);

  /** Guards the one-shot "open today's daily note on startup" effect. */
  private dailyNoteStartupDone = false;

  constructor() {
    // Subscribe to the quick-capture hotkey for the app's lifetime.
    inject(DailyNoteService).start();
    // Instantiate so its effect drains on-save Action outcomes (ADR-0011).
    inject(ActionsService);
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
    // Instantiate so the assistant panel reacts to the active note.
    inject(AssistantService);
    // Instantiate so the app-wide accent + UI scale from Settings ->
    // Appearance are applied on startup and kept in sync.
    inject(AppearanceService);
    // Listen for MCP client write-confirmations / vault-changed pushes (ADR-0021).
    inject(McpBridgeService).start();
    // Install the capture-phase contextmenu listener that gives the editor
    // its own right-click menu in place of the OS one (ADR-0030).
    inject(EditorContextMenuService).start();

    // Open today's daily note once, after both the vault path and the
    // persisted config are known. `vault.refresh()` re-runs after saves, so
    // the boolean guard (not just the signal) keeps this to a single open;
    // it is consumed even when the setting is off, so flipping it on later
    // in the session does not retroactively open a tab.
    effect(() => {
      const vaultPath = this.vault.activeVaultPath();
      const loaded = this.settings.loaded();
      if (this.dailyNoteStartupDone || !vaultPath || !loaded) {
        return;
      }
      this.dailyNoteStartupDone = true;
      if (this.settings.dailyOpenOnStartup()) {
        void this.editor.openDailyNote(formatDate(new Date()));
      }
    });

    // App-wide keyboard commands. Features register here the same way; the
    // titlebar menu bar invokes the same command ids.
    const keys = inject(KeybindingService);
    const tagSearch = inject(TagSearchService);
    keys.register({
      id: 'search.open',
      label: 'Search notes',
      keybinding: 'Mod+Shift+F',
      run: () => {
        this.dock.openAndExpand('search');
        tagSearch.openPanel();
      },
    });
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

    const templates = inject(TemplateLibraryService);
    keys.register({
      id: 'template.insert',
      label: 'Insert template',
      keybinding: 'Mod+T',
      run: () => templates.openPicker(),
    });
    keys.register({
      id: 'input.recover',
      label: 'Recover input focus',
      keybinding: 'Mod+Alt+Shift+R',
      run: () => recovery.recover('manual'),
    });
  }
}
