import { Component, HostListener, inject } from '@angular/core';
import { Editor } from './editor/editor';
import { ChatInput } from './chat-input/chat-input';
import { DailyNoteService } from './services/daily-note.service';
import { EditorService } from './services/editor.service';
import { LayoutService } from './services/layout.service';
import { Sidebar } from './sidebar/sidebar';
import { TabBar } from './tab-bar/tab-bar';

/**
 * Root shell: two columns per CLAUDE.md's "UI/UX Design" -- sidebar on the
 * left, and on the right a tab bar + editor (once at least one document is
 * open) with the chat input bar pinned to the bottom. Quick-capture
 * (`DailyNoteService`) wires the Ctrl+Alt+N hotkey for the app's lifetime.
 *
 * The two drag handles (sidebar|main, editor|chat-input) are the only
 * imperative code here: pointer capture on the handle keeps the drag alive
 * outside the 6px strip, and the moved-to size is pushed straight into
 * `LayoutService` (which clamps and persists it). Native pointer events,
 * no CDK / split-pane dependency -- it's ~15 lines and the project keeps
 * its dependency surface deliberately small (see icons/icon.ts for the
 * same call).
 */
@Component({
  selector: 'app-root',
  imports: [Sidebar, TabBar, Editor, ChatInput],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly ipcAvailable = typeof window !== 'undefined' && !!window.dreyApi;
  protected readonly editor = inject(EditorService);
  protected readonly layout = inject(LayoutService);

  /** Which handle is being dragged, or null when idle. */
  private drag: 'sidebar' | 'chat' | null = null;

  constructor() {
    // Subscribe to the quick-capture hotkey for the app's lifetime.
    inject(DailyNoteService).start();
  }

  protected startSidebarDrag(event: PointerEvent): void {
    this.beginDrag('sidebar', event);
  }

  protected startChatDrag(event: PointerEvent): void {
    this.beginDrag('chat', event);
  }

  private beginDrag(which: 'sidebar' | 'chat', event: PointerEvent): void {
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
    } else if (this.drag === 'chat') {
      this.layout.setChatInputHeight(window.innerHeight - event.clientY);
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
