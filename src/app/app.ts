import { Component, inject } from '@angular/core';
import { Editor } from './editor/editor';
import { ConfirmationDialog } from './confirmation-dialog/confirmation-dialog';
import { ActionsService } from './services/actions.service';
import { AppearanceService } from './services/appearance.service';
import { AssistantService } from './services/assistant.service';
import { DailyNoteService } from './services/daily-note.service';
import { EditorService } from './services/editor.service';
import { EditorZoomService } from './services/editor-zoom.service';
import { McpBridgeService } from './services/mcp-bridge.service';
import { SettingsService } from './services/settings.service';
import { KeybindingService } from './keybindings';
import { TagSearchService } from './tags';
import { Dock, DockService } from './dock';
import { Titlebar } from './titlebar';
import { StatusBar } from './status-bar/status-bar';
import { Settings } from './settings/settings';
import { TabBar } from './tab-bar/tab-bar';

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
  imports: [Titlebar, Dock, StatusBar, TabBar, Editor, Settings, ConfirmationDialog],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly ipcAvailable = typeof window !== 'undefined' && !!window.dreyApi;
  protected readonly editor = inject(EditorService);
  protected readonly settings = inject(SettingsService);
  protected readonly dock = inject(DockService);

  constructor() {
    // Subscribe to the quick-capture hotkey for the app's lifetime.
    inject(DailyNoteService).start();
    // Instantiate so its effect drains on-save Action outcomes (ADR-0011).
    inject(ActionsService);
    // Instantiate at startup so its global Ctrl+wheel guard is installed
    // even before the first document (and its editor) opens (ADR-0015).
    inject(EditorZoomService);
    // Instantiate so the assistant panel reacts to the active note.
    inject(AssistantService);
    // Instantiate so the app-wide accent + UI scale from Settings ->
    // Appearance are applied on startup and kept in sync.
    inject(AppearanceService);
    // Listen for MCP client write-confirmations / vault-changed pushes (ADR-0021).
    inject(McpBridgeService).start();

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
  }
}
