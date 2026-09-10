import {
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  inject,
  viewChild,
} from '@angular/core';
import { Icon } from '../icons/icon';
import { OverlayGuardDirective } from '../services/overlay-guard.directive';
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
  imports: [ImageViewer, Icon, OverlayGuardDirective],
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
        const active = document.activeElement;
        // Only remember a *real*, still-attached element that isn't <body>
        // -- restoring focus to a detached node (or to <body>) is how the
        // caret can end up nowhere after a rapid open/close.
        this.restoreFocusTo =
          active instanceof HTMLElement && active.isConnected && active !== document.body
            ? active
            : null;
        // Wait for the button to render, then move focus into the overlay.
        queueMicrotask(() => {
          const btn = this.closeBtn()?.nativeElement;
          if (btn?.isConnected) {
            btn.focus();
          }
        });
      } else if (this.restoreFocusTo) {
        const target = this.restoreFocusTo;
        this.restoreFocusTo = null;
        if (target.isConnected) {
          target.focus();
        }
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

  protected onBackdropClick(event: MouseEvent): void {
    // Click on empty space closes (Preview / Photos behaviour). The viewer
    // fills the overlay, so this catches clicks on the stage that aren't on
    // the image or a control; a real pan drag moves the pointer far enough
    // that no `click` fires.
    const target = event.target as HTMLElement | null;
    if (
      !target ||
      target.tagName === 'IMG' ||
      target.closest('.zoom-cluster') ||
      target.closest('.close')
    ) {
      return;
    }
    this.lightbox.close();
  }
}
