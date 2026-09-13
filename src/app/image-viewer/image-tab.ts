import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  OnDestroy,
  viewChild,
} from '@angular/core';
import { resolveVaultImageUrl } from '../editor/vault-image';
import { EditorService } from '../services/editor.service';
import { ImageViewer } from './image-viewer';
import { ImageLightboxService } from './image-lightbox.service';

/**
 * One pane's view for a `kind: 'image'` tab (ADR-0026), picked over
 * `<app-editor>` by `PaneLeaf` when that pane's shown document is an
 * image. A 34px meta bar (path · zoom % · Fullscreen) over the shared
 * `ImageViewer`; `+` / `-` / `0` drive the viewer unless the lightbox is
 * open over it.
 *
 * `focused` (ADR-0037: is *this pane* the focused one) gates the global
 * `+`/`-`/`0` keydown and the status bar's viewport feed -- with more than
 * one image pane open, only the focused one should react to a zoom
 * keystroke or claim the status bar's zoom readout.
 */
@Component({
  selector: 'app-image-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ImageViewer],
  templateUrl: './image-tab.html',
  styleUrl: './image-tab.css',
  host: {
    '(document:keydown)': 'onKey($event)',
    // This tab's vault-relative image path, for the context menu's click
    // target (ADR-0050).
    '[attr.data-drey-image]': 'path()',
  },
})
export class ImageTab implements OnDestroy {
  protected readonly editor = inject(EditorService);
  private readonly lightbox = inject(ImageLightboxService);
  protected readonly viewer = viewChild.required(ImageViewer);

  readonly path = input.required<string>();
  readonly focused = input(true);

  protected readonly url = computed(() => resolveVaultImageUrl(null, this.path()) ?? '');

  constructor() {
    // Feed the status bar the live viewport -- focused pane only.
    effect(() => {
      const v = this.viewer();
      if (!this.focused()) {
        return;
      }
      this.editor.setImageViewport({
        naturalWidth: v.natural().w,
        naturalHeight: v.natural().h,
        scale: v.scale(),
      });
    });
  }

  ngOnDestroy(): void {
    if (this.focused()) {
      this.editor.setImageViewport(null);
    }
  }

  protected openFullscreen(): void {
    this.lightbox.open(this.url());
  }

  protected onKey(event: KeyboardEvent): void {
    if (!this.focused() || this.lightbox.src()) {
      return; // another pane's keydown, or the overlay owns the keys while it's up
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
