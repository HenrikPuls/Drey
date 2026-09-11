import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Icon } from '../icons/icon';
import { DocKindRegistry } from '../plugin-host';
import { EditorService } from '../services/editor.service';
import { SettingsService } from '../services/settings.service';

/**
 * The 26px status bar pinned to the bottom of the shell: word / character
 * count for the active document (or the pixel size + zoom for an image
 * tab, ADR-0026), and the Settings entry at the right (moved off the old
 * sidebar footer).
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
  private readonly docKinds = inject(DocKindRegistry);

  /** `"<W> × <H> · <zoom>%"` for the active image tab; `—` before it loads. */
  protected readonly imageInfo = computed(() => {
    const v = this.editor.imageViewport();
    if (!v) {
      return '—';
    }
    const dims = v.naturalWidth && v.naturalHeight ? `${v.naturalWidth} × ${v.naturalHeight}` : '—';
    return `${dims} · ${Math.round(v.scale * 100)}%`;
  });

  /**
   * The active tab's status line when its kind is a registered doc kind
   * (the browser's URL, ADR-0044 stage 8A -- was the hardcoded
   * `kind === 'browser'` branch); null for the base kinds, which fall
   * through to the word/char count.
   */
  protected readonly docKindStatus = computed<string | null>(() => {
    const doc = this.editor.openDocs().find((d) => d.path === this.editor.activePath());
    if (doc === undefined || doc.kind === 'text' || doc.kind === 'image') {
      return null;
    }
    return this.docKinds.statusTextFor(doc.kind, doc.path);
  });
}
