import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { EditorService } from '../services/editor.service';
import { Icon } from '../icons/icon';

/**
 * The sidebar's "open windows" list -- currently a mirror of the open
 * editor tabs (`EditorService.openDocs`). It becomes more than that once
 * saved searches / detached windows exist; for now clicking a row just
 * activates that tab.
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

  protected onClose(event: MouseEvent, path: string): void {
    event.stopPropagation();
    this.editor.closeTab(path);
  }
}
