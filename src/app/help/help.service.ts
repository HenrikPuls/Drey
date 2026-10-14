import { Injectable, inject } from '@angular/core';
import { KeybindingService } from '../keybindings';
import { EditorService } from '../services/editor.service';
import { SettingsService } from '../services/settings.service';
import { buildShortcutsMarkdown } from './shortcuts-doc';

/**
 * The Help menu's backing service (ADR-0070): opens the bundled user
 * manual and the generated keyboard shortcuts document as read-only,
 * pinned editor tabs (`EditorService.openHelpDoc`).
 *
 * The manual ships in the app bundle -- `scripts/sync-manual.mjs` mirrors
 * `docs/manual/` into `public/manual/`, Angular copies it under the app
 * origin, and the page's own origin serves it in dev (`ng serve`) and
 * packaged (`app://`) alike. Fetched relative, never absolute, so the
 * same code path works everywhere; a fetch error is surfaced through the
 * editor's error line (a manual missing from the build is a packaging
 * bug, not a user problem).
 */
@Injectable({ providedIn: 'root' })
export class HelpService {
  private readonly editor = inject(EditorService);
  private readonly keys = inject(KeybindingService);
  private readonly settings = inject(SettingsService);

  /** Where the bundled manual lives under the app origin. */
  static readonly MANUAL_URL = 'manual/manual.md';
  /** The manual tab's path / key in the vault-less help namespace. */
  static readonly MANUAL_PATH = 'help/manual.md';
  /** The shortcuts tab's path / key. */
  static readonly SHORTCUTS_PATH = 'help/shortcuts.md';

  /** Help -> "User manual" (F1): opens the bundled manual read-only. */
  async openManual(): Promise<void> {
    try {
      const response = await fetch(HelpService.MANUAL_URL);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const content = await response.text();
      this.editor.openHelpDoc(HelpService.MANUAL_PATH, 'User manual', content, 'manual/');
    } catch {
      this.editor.error.set(
        'The user manual could not be loaded — it is missing from this build.',
      );
    }
  }

  /** Help -> "Keyboard shortcuts": opens the generated list read-only. */
  openShortcuts(): void {
    this.editor.openHelpDoc(
      HelpService.SHORTCUTS_PATH,
      'Keyboard shortcuts',
      buildShortcutsMarkdown(this.keys.all(), this.settings.config()?.keybindings.capture),
    );
  }
}
