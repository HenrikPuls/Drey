import { Injectable, signal } from '@angular/core';

/**
 * The whole-app image lightbox (ADR-0026). A single `src` signal the
 * `ImageLightbox` component self-gates on -- the `ConfirmationService`
 * lifecycle pattern, so a CodeMirror widget (the Live Preview lens
 * button) can open it with a plain method call and no id-counter dance.
 */
@Injectable({ providedIn: 'root' })
export class ImageLightboxService {
  private readonly _src = signal<string | null>(null);

  /** The image URL currently shown full-screen, or `null` when closed. */
  readonly src = this._src.asReadonly();

  open(src: string): void {
    this._src.set(src);
  }

  close(): void {
    this._src.set(null);
  }
}
