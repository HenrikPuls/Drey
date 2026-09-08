import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  OnDestroy,
  viewChild,
} from '@angular/core';
import { resolveVaultImageUrl } from '../editor/vault-image';
import { EditorService } from '../services/editor.service';
import { ImageViewer } from './image-viewer';
import { ImageLightboxService } from './image-lightbox.service';

/**
 * The centre-column view for a `kind: 'image'` tab (ADR-0026) -- picked
 * over `<app-editor>` by `editor.activeKind()`. A 34px meta bar (path ·
 * zoom % · Fullscreen) over the shared `ImageViewer`; `+` / `-` / `0`
 * drive the viewer unless the lightbox is open over it.
 */
@Component({
  selector: 'app-image-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ImageViewer],
  templateUrl: './image-tab.html',
  styleUrl: './image-tab.css',
  host: { '(document:keydown)': 'onKey($event)' },
})
export class ImageTab implements OnDestroy {
  protected readonly editor = inject(EditorService);
  private readonly lightbox = inject(ImageLightboxService);
  protected readonly viewer = viewChild.required(ImageViewer);

  protected readonly path = this.editor.activePath;
  protected readonly url = computed(
    () => resolveVaultImageUrl(null, this.editor.activePath() ?? '') ?? '',
  );

  constructor() {
    // Feed the status bar the live viewport.
    effect(() => {
      const v = this.viewer();
      this.editor.setImageViewport({
        naturalWidth: v.natural().w,
        naturalHeight: v.natural().h,
        scale: v.scale(),
      });
    });
  }

  ngOnDestroy(): void {
    this.editor.setImageViewport(null);
  }

  protected openFullscreen(): void {
    this.lightbox.open(this.url());
  }

  protected onKey(event: KeyboardEvent): void {
    if (this.lightbox.src()) {
      return; // the overlay owns the keys while it's up
    }
    const v = this.viewer();
    switch (event.key) {
      case '+':
      case '=':
        v.zoomIn();
        event.preventDefault();
        break;
      case '-':
      case '_':
        v.zoomOut();
        event.preventDefault();
        break;
      case '0':
        v.reset100();
        event.preventDefault();
        break;
    }
  }
}
