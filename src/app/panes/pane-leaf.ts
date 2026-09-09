import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Editor } from '../editor/editor';
import { ImageTab } from '../image-viewer';
import { EditorService } from '../services/editor.service';
import { TabBar } from '../tab-bar/tab-bar';
import { PaneService } from './pane.service';

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
 */
@Component({
  selector: 'app-pane-leaf',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TabBar, Editor, ImageTab],
  templateUrl: './pane-leaf.html',
  styleUrl: './pane-leaf.css',
  host: {
    '(mousedown)': 'panes.focus(paneId())',
  },
})
export class PaneLeaf {
  protected readonly panes = inject(PaneService);
  private readonly editor = inject(EditorService);

  readonly paneId = input.required<string>();

  protected readonly pane = computed(() => this.panes.pane(this.paneId()));
  protected readonly activeDoc = computed(() => this.editor.docFor(this.pane()?.active ?? null));
  protected readonly focused = computed(() => this.panes.focusedId() === this.paneId());
}
