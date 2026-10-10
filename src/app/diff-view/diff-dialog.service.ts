import { Injectable, signal } from '@angular/core';
import type { DiffRequest } from '../../../shared/plugin-api/renderer';

/**
 * The read-only diff dialog's state (SDK 1.17, `api.ui.showDiff`): one
 * comparison at a time, shown through the shared `DiffView`. A second
 * request replaces the first, which resolves as closed.
 */
@Injectable({ providedIn: 'root' })
export class DiffDialogService {
  readonly request = signal<DiffRequest | null>(null);
  private resolve: (() => void) | null = null;

  /** Opens the dialog; resolves once it is closed. */
  show(request: DiffRequest): Promise<void> {
    this.close();
    this.request.set(request);
    return new Promise<void>((resolve) => {
      this.resolve = resolve;
    });
  }

  close(): void {
    this.request.set(null);
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.();
  }
}
