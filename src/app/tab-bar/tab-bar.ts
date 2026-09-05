import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { EditorService } from '../services/editor.service';
import { Icon } from '../icons/icon';

/**
 * The row of document tabs above the editor. Pure view over
 * `EditorService.openDocs` / `activePath`: click activates, the X closes
 * (a dirty tab confirms first, in the service). The "+" button is a
 * deliberate placeholder until there's a "new note" flow to hang on it
 * (milestone 5, tag routing).
 */
@Component({
  selector: 'app-tab-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  templateUrl: './tab-bar.html',
  styleUrl: './tab-bar.css',
})
export class TabBar {
  protected readonly editor = inject(EditorService);

  protected onClose(event: MouseEvent, path: string): void {
    event.stopPropagation();
    this.editor.closeTab(path);
  }
}
