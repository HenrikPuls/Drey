import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { resolveVaultImageUrl } from '../editor/vault-image';

/**
 * One pane's view for a `kind: 'pdf'` tab (ADR-0052), picked over
 * `<app-editor>` by `PaneLeaf` when that pane's shown document is a PDF. A
 * 34px meta bar (path) above Chromium's built-in (PDFium) viewer in an
 * `<iframe>` -- `plugins: true` on the main window enables the viewer, and
 * the frame keeps its own toolbar (zoom, page navigation, find). No global
 * keydown handler: while the frame has focus, keys belong to the PDF
 * viewer, not the editor's keymap.
 */
@Component({
  selector: 'app-pdf-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './pdf-tab.html',
  styleUrl: './pdf-tab.css',
})
export class PdfTab {
  /** The PDF's vault-relative path (the shown doc's `path`, not its tab key). */
  readonly path = input.required<string>();
  /** The PDF's vault (ADR-0051); the asset URL is served per vault. */
  readonly vaultId = input<string | null>(null);
  /** Present for parity with `ImageTab`; the PDF viewer owns its own keys. */
  readonly focused = input(true);

  private readonly sanitizer = inject(DomSanitizer);

  /**
   * Angular refuses a plain string as a frame URL, so the resolved one is
   * marked trusted -- but only the vault's own `drey-asset:` scheme, which
   * main serves from inside a registered vault and nowhere else.
   */
  protected readonly url = computed((): SafeResourceUrl | null => {
    const resolved = resolveVaultImageUrl(null, this.path(), this.vaultId());
    return resolved !== null && resolved.startsWith('drey-asset:')
      ? this.sanitizer.bypassSecurityTrustResourceUrl(resolved)
      : null;
  });
}
