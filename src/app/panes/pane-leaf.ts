import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { BrowserTab } from '../browser';
import { Editor } from '../editor/editor';
import { ImageTab } from '../image-viewer';
import { EditorService } from '../services/editor.service';
import { TabBar } from '../tab-bar/tab-bar';
import { TabDragService } from '../tab-bar/tab-drag.service';
import { PaneDropService } from './pane-drop.service';
import { PaneService } from './pane.service';

/** Elements with their own drop handling (CodeMirror content, native fields). */
const OWNS_DROP = '.cm-content, input, textarea, [contenteditable="true"]';

/**
 * One leaf of the pane split tree (`PaneLayout`): a pane's own tab strip
 * plus its shown document -- `Editor` for text, `ImageTab` for an image
 * viewer (ADR-0026), or an empty state while it has no tabs (only possible
 * for the tree's sole pane; a non-root pane collapses out of the layout the
 * moment its last tab closes, see `PaneService`).
 *
 * A `mousedown` anywhere in the pane (a tab, the meta bar, the content)
 * focuses it -- the same "whichever pane you interact with becomes the one
 * `EditorService`'s facade follows" rule `PaneService`'s doc comment
 * describes.
 *
 * `data-pane-id` on the host makes the whole pane body a tab drop target
 * (ADR-0039): a tab dropped anywhere in it that is not over a tab strip
 * (`data-tabstrip-pane`, `TabBar`) moves into this pane, appended.
 *
 * A **file** dropped on the pane body but not into `.cm-content` (the tab
 * strip, meta bar, empty state, the padding / gutter around the text) opens
 * as a tab here -- `PaneDropService` (amends ADR-0027 / ADR-0028). A drop on
 * `.cm-content` is left to CodeMirror's own handler (image link / inlined
 * text, ADR-0028).
 */
@Component({
  selector: 'app-pane-leaf',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TabBar, Editor, ImageTab, BrowserTab],
  templateUrl: './pane-leaf.html',
  styleUrl: './pane-leaf.css',
  host: {
    '[attr.data-pane-id]': 'paneId()',
    '[class.drop-target]': 'isBodyDropTarget()',
    '[class.file-drop-target]': 'fileDropActive()',
    '(mousedown)': 'panes.focus(paneId())',
    '(dragover)': 'onDragOver($event)',
    '(dragleave)': 'onDragLeave($event)',
    '(drop)': 'onDrop($event)',
  },
})
export class PaneLeaf {
  protected readonly panes = inject(PaneService);
  protected readonly tabDrag = inject(TabDragService);
  private readonly editor = inject(EditorService);
  private readonly paneDrop = inject(PaneDropService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  readonly paneId = input.required<string>();

  protected readonly pane = computed(() => this.panes.pane(this.paneId()));
  protected readonly activeDoc = computed(() => this.editor.docFor(this.pane()?.active ?? null));
  protected readonly focused = computed(() => this.panes.focusedId() === this.paneId());

  /** A tab is being dragged over this pane's body (not its strip) -- show the wash. */
  protected readonly isBodyDropTarget = computed(() => {
    const t = this.tabDrag.dropTarget();
    return !!t && t.kind === 'body' && t.paneId === this.paneId();
  });

  /** A file drag is hovering this pane's body (not its text) -- show the wash. */
  protected readonly fileDropActive = signal(false);

  protected onDragOver(event: DragEvent): void {
    if (ownsDrop(event.target) || !this.paneDrop.canOpen(event.dataTransfer)) {
      return;
    }
    event.preventDefault(); // required for `drop` to fire here instead of navigating
    this.fileDropActive.set(true);
  }

  protected onDragLeave(event: DragEvent): void {
    // Ignore the boundary crossings between child elements -- only clear
    // once the pointer has actually left the pane.
    if (event.relatedTarget instanceof Node && this.host.contains(event.relatedTarget)) {
      return;
    }
    this.fileDropActive.set(false);
  }

  protected onDrop(event: DragEvent): void {
    this.fileDropActive.set(false);
    if (ownsDrop(event.target) || !this.paneDrop.canOpen(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void this.paneDrop.openFromDrop(this.paneId(), event.dataTransfer);
  }
}

function ownsDrop(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(OWNS_DROP) !== null;
}
