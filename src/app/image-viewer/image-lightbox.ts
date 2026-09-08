import {
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  inject,
  viewChild,
} from '@angular/core';
import { Icon } from '../icons/icon';
import { ImageViewer } from './image-viewer';
import { ImageLightboxService } from './image-lightbox.service';

/**
 * The whole-app image overlay (ADR-0026). Always mounted, self-gated on
 * `ImageLightboxService.src()` (the `ConfirmationDialog` recipe). Covers
 * `inset: 0` at `z-index: var(--z-lightbox)`, above every other overlay.
 *
 * Escape and a backdrop click close it; `+` / `-` / `0` drive the shared
 * `ImageViewer` (component-local key handling, not a global keybinding
 * command -- registering bare keys there would break typing).
 */
@Component({
  selector: 'app-image-lightbox',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ImageViewer, Icon],
  templateUrl: './image-lightbox.html',
  styleUrl: './image-lightbox.css',
  host: {
    '(document:keydown.escape)': 'onEscape($event)',
    '(document:keydown)': 'onKey($event)',
  },
})
export class ImageLightbox {
  protected readonly lightbox = inject(ImageLightboxService);
  private readonly viewer = viewChild(ImageViewer);
  private readonly closeBtn = viewChild<ElementRef<HTMLButtonElement>>('closeBtn');

  private restoreFocusTo: HTMLElement | null = null;

  constructor() {
    effect(() => {
      if (this.lightbox.src()) {
        this.restoreFocusTo =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        // Wait for the button to render, then move focus into the overlay.
        queueMicrotask(() => this.closeBtn()?.nativeElement.focus());
      } else if (this.restoreFocusTo) {
        this.restoreFocusTo.focus();
        this.restoreFocusTo = null;
      }
    });
  }

  protected onEscape(event: Event): void {
    if (this.lightbox.src()) {
      event.stopPropagation();
      this.lightbox.close();
    }
  }

  protected onKey(event: KeyboardEvent): void {
    if (!this.lightbox.src()) {
      return;
    }
    const v = this.viewer();
    if (!v) {
      return;
    }
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

  protected onBackdropPointer(event: PointerEvent): void {
    // Close only on a genuine click of the backdrop itself -- a pan gesture
    // captures the pointer on the stage, so its target is never the backdrop.
    if (event.target === event.currentTarget) {
      this.lightbox.close();
    }
  }
}
