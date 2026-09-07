import { Injectable, effect, inject } from '@angular/core';
import { UI_SCALE_FACTORS, resolveAccentHex } from '../../../shared/app-config';
import { SettingsService } from './settings.service';

/**
 * Applies the app-wide look from `Settings -> Appearance` (`AppearanceConfig`)
 * to the live document:
 *
 * - the highlight colour is written onto `--accent` at the document root;
 *   the `--accent-*` tint tokens in `styles.css` are `color-mix()`ed off it,
 *   so one write re-colours chips, buttons, the text selection and the
 *   splitter hovers.
 * - the UI scale goes through `webContents.setZoomFactor` (main process),
 *   the same path a browser's Ctrl +/- uses -- layout and pointer
 *   coordinates scale together. It resets on reload, so this re-sends it
 *   whenever the config is (re)loaded.
 *
 * This is the first code to override a `:root`-level CSS variable at
 * runtime; the editor's `fontScale` / `fontFamily` (ADR-0015) stay
 * host-scoped to `<app-editor>`. Instantiated once from `App`.
 */
@Injectable({ providedIn: 'root' })
export class AppearanceService {
  private readonly settings = inject(SettingsService);

  constructor() {
    effect(() => {
      const hex = resolveAccentHex(this.settings.appearanceAccent());
      if (typeof document !== 'undefined') {
        document.documentElement.style.setProperty('--accent', hex);
      }
    });

    effect(() => {
      const factor = UI_SCALE_FACTORS[this.settings.appearanceUiScale()];
      const api = typeof window !== 'undefined' ? window.dreyApi : undefined;
      void api?.setUiZoomFactor(factor);
    });
  }
}
