import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Icon } from '../icons/icon';
import { DockService } from '../dock';
import { EditorService } from '../services/editor.service';
import { SettingsService } from '../services/settings.service';

/**
 * The 26px status bar pinned to the bottom of the shell: word / character
 * count for the active document, a context hint (which becomes the drag
 * instruction while a panel is being moved), and the Settings entry at the
 * right (moved off the old sidebar footer).
 */
@Component({
  selector: 'app-status-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  templateUrl: './status-bar.html',
  styleUrl: './status-bar.css',
})
export class StatusBar {
  protected readonly editor = inject(EditorService);
  protected readonly settings = inject(SettingsService);
  private readonly dock = inject(DockService);

  protected readonly hint = computed(() =>
    this.dock.dragging()
      ? 'Drop the panel into a dock'
      : 'Drag a panel header to move it · drag the edges to resize',
  );
}
