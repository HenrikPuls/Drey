import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { PaneService } from '../panes/pane.service';
import { EditorService, type OpenDoc } from '../services/editor.service';
import { ViewService } from '../views';
import { Icon } from '../icons/icon';

/**
 * The sidebar's "open windows" list -- currently a mirror of the open
 * editor tabs of the ACTIVE view; documents that only other views show are
 * listed under "In other views" with a "Show here" button (ADR-0089).
 * Clicking a row activates that tab.
 */
@Component({
  selector: 'app-open-windows',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  templateUrl: './open-windows.html',
  styleUrl: './open-windows.css',
})
export class OpenWindows {
  protected readonly editor = inject(EditorService);
  protected readonly views = inject(ViewService);
  private readonly panes = inject(PaneService);

  /** Open documents the active view shows. */
  protected readonly shown = computed<OpenDoc[]>(() => {
    const keys = new Set(this.panes.tabsOfView(this.views.activeId()));
    return this.editor.openDocs().filter((d) => keys.has(d.key));
  });

  /** Open documents the active view does not show, with the views that do. */
  protected readonly elsewhere = computed<Array<{ doc: OpenDoc; where: string }>>(() => {
    const keys = new Set(this.panes.tabsOfView(this.views.activeId()));
    const labels = new Map(this.views.views().map((v) => [v.id, v.label]));
    return this.editor
      .openDocs()
      .filter((d) => !keys.has(d.key))
      .map((doc) => ({
        doc,
        where: this.views
          .viewsOfTab(doc.key)
          .map((id) => labels.get(id) ?? id)
          .join(', '),
      }));
  });

  protected onClose(event: MouseEvent, path: string): void {
    event.stopPropagation();
    void this.editor.closeTab(path);
  }
}
