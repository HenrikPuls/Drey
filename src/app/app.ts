import { Component, HostListener, inject } from '@angular/core';
import { Editor } from './editor/editor';
import { EntryDrawer } from './entry-drawer/entry-drawer';
import { NoteAssistant } from './note-assistant/note-assistant';
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
import { Settings } from './settings/settings';
import { Sidebar } from './sidebar/sidebar';
import { TabBar } from './tab-bar/tab-bar';

/**
 * Root shell: sidebar, main area, and the note assistant panel on the
 * right. The main area is a tab bar + editor (once at least one document is
 * open) with the "Eintrag hinzufügen" drawer pinned to its bottom.
 * Quick-capture (`DailyNoteService`) wires the Ctrl+Alt+N hotkey for the
 * app's lifetime.
 *
 * The bottom chat bar this shell used to carry is gone: its capture role
 * became the drawer (Feature B) and its Ask role the assistant panel's
 * composer (Feature A), so each job now lives in exactly one place.
 *
 * The three drag handles (sidebar|main, editor|drawer, main|assistant) are
 * the only imperative code here: pointer capture on the handle keeps the
 * drag alive outside the 6px strip, and the moved-to size is pushed into
 * `LayoutService` (which clamps and persists it). Native pointer events,
 * no CDK / split-pane dependency -- it's ~15 lines and the project keeps
 * its dependency surface deliberately small (see icons/icon.ts for the
 * same call).
 */
@Component({
  selector: 'app-root',
  imports: [Sidebar, TabBar, Editor, EntryDrawer, NoteAssistant, Settings, ConfirmationDialog],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly ipcAvailable = typeof window !== 'undefined' && !!window.dreyApi;
  protected readonly editor = inject(EditorService);
  protected readonly layout = inject(LayoutService);
  protected readonly settings = inject(SettingsService);
  protected readonly assistant = inject(AssistantService);
  protected readonly drawer = inject(EntryDraftService);

  /** Which handle is being dragged, or null when idle. */
  private drag: 'sidebar' | 'assistant' | 'drawer' | null = null;

  constructor() {
    // Subscribe to the quick-capture hotkey for the app's lifetime.
    inject(DailyNoteService).start();
    // Instantiate so its effect drains on-save Action outcomes (ADR-0011).
    inject(ActionsService);
    // Instantiate at startup so its global Ctrl+wheel guard is installed
    // even before the first document (and its editor) opens (ADR-0015).
    inject(EditorZoomService);

    // App-wide keyboard commands. More features register here the same way.
    const keys = inject(KeybindingService);
    const tagSearch = inject(TagSearchService);
    keys.register({
      id: 'search.open',
      label: 'Search notes',
      keybinding: 'Mod+Shift+F',
      run: () => tagSearch.openPanel(),
    });
  }

  protected startSidebarDrag(event: PointerEvent): void {
    this.beginDrag('sidebar', event);
  }

  protected startAssistantDrag(event: PointerEvent): void {
    this.beginDrag('assistant', event);
  }

  protected startDrawerDrag(event: PointerEvent): void {
    this.beginDrag('drawer', event);
  }

  private beginDrag(which: 'sidebar' | 'assistant' | 'drawer', event: PointerEvent): void {
    event.preventDefault();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    this.drag = which;
    document.body.style.userSelect = 'none';
  }

  @HostListener('pointermove', ['$event'])
  protected onPointerMove(event: PointerEvent): void {
    if (this.drag === 'sidebar') {
      // Sidebar starts at viewport x=0, so the pointer's clientX is the width.
      this.layout.setSidebarWidth(event.clientX);
    } else if (this.drag === 'assistant') {
      // The panel is flush with the right edge, so its width is whatever
      // is left between the pointer and that edge.
      this.layout.setAssistantWidth(window.innerWidth - event.clientX);
    } else if (this.drag === 'drawer') {
      // Same idea vertically: the drawer sits on the window's bottom edge.
      this.layout.setDrawerHeight(window.innerHeight - event.clientY);
    }
  }

  @HostListener('pointerup')
  @HostListener('pointercancel')
  protected onPointerUp(): void {
    if (this.drag) {
      this.drag = null;
      document.body.style.userSelect = '';
    }
  }
}
