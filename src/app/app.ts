import { Component, HostListener, inject } from '@angular/core';
import { Editor } from './editor/editor';
import { EntryDrawer } from './entry-drawer/entry-drawer';
import { ConfirmationDialog } from './confirmation-dialog/confirmation-dialog';
import { ActionsService } from './services/actions.service';
import { AssistantService } from './services/assistant.service';
import { EntryDraftService } from './services/entry-draft.service';
import { DailyNoteService } from './services/daily-note.service';
import { EditorService } from './services/editor.service';
import { EditorZoomService } from './services/editor-zoom.service';
import { LayoutService } from './services/layout.service';
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
 * The main column is a tab bar + editor (once at least one document is
 * open) with the "Add entry" drawer pinned to its bottom. Quick-capture
 * (`DailyNoteService`) wires the Ctrl+Alt+N hotkey for the app's lifetime.
 *
 * The only imperative code here is the entry-drawer resize handle: pointer
 * capture keeps the drag alive outside the 6px strip, and the moved-to size
 * is pushed into `LayoutService`. The dock widths get their own edge
 * resizers in step 3.
 */
@Component({
  selector: 'app-root',
  imports: [Titlebar, Dock, StatusBar, TabBar, Editor, EntryDrawer, Settings, ConfirmationDialog],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly ipcAvailable = typeof window !== 'undefined' && !!window.dreyApi;
  protected readonly editor = inject(EditorService);
  protected readonly layout = inject(LayoutService);
  protected readonly settings = inject(SettingsService);
  protected readonly dock = inject(DockService);
  protected readonly drawer = inject(EntryDraftService);

  private dragging = false;

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

  protected startDrawerDrag(event: PointerEvent): void {
    event.preventDefault();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    this.dragging = true;
    document.body.style.userSelect = 'none';
  }

  @HostListener('pointermove', ['$event'])
  protected onPointerMove(event: PointerEvent): void {
    if (this.dragging) {
      // The drawer sits on the window's bottom edge.
      this.layout.setDrawerHeight(window.innerHeight - event.clientY);
    }
  }

  @HostListener('pointerup')
  @HostListener('pointercancel')
  protected onPointerUp(): void {
    if (this.dragging) {
      this.dragging = false;
      document.body.style.userSelect = '';
    }
  }
}
