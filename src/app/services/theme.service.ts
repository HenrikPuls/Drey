import { Injectable, computed, effect, inject } from '@angular/core';
import { DREY_THEME } from '../../../shared/app-config';
import { resolveTheme, ThemeCatalogEntry } from '../editor/themes/theme-catalog';
import { SettingsService } from './settings.service';

/**
 * Applies the selected theme (`Settings -> Appearance`) to the app shell.
 *
 * The CodeMirror surface swaps its own theme in a compartment
 * (`MarkdownSurface`); this service handles everything *outside* the
 * editor. For a published theme it writes the seed's `bg` / `fg` onto
 * `--_bg` / `--_fg` at the document root and sets `data-theme`, which
 * activates `styles.css`'s `:root[data-theme]` block -- the whole token set
 * (`--bg-*`, the text ramp, borders, hover fills) is `color-mix()`ed off
 * those two. For the built-in **Drey** theme it clears both, so the bespoke
 * `:root` palette is used verbatim.
 *
 * Mirrors `AppearanceService` (accent + UI scale) and is instantiated once
 * from `App`. Exposes the resolved catalog entry as a signal so the editor
 * and `AppearanceService` (for the `'theme'` accent sentinel) can read it.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly settings = inject(SettingsService);

  /** The resolved catalog entry for the current `appearance.theme`. */
  readonly theme = computed<ThemeCatalogEntry>(() => resolveTheme(this.settings.appearanceTheme()));

  constructor() {
    effect(() => {
      const entry = this.theme();
      if (typeof document === 'undefined') {
        return;
      }
      const root = document.documentElement;
      if (entry.id === DREY_THEME) {
        delete root.dataset['theme'];
        root.style.removeProperty('--_bg');
        root.style.removeProperty('--_fg');
        root.style.removeProperty('color-scheme');
        return;
      }
      root.dataset['theme'] = entry.id;
      root.style.setProperty('--_bg', entry.seed.bg);
      root.style.setProperty('--_fg', entry.seed.fg);
      root.style.setProperty('color-scheme', entry.seed.dark ? 'dark' : 'light');
    });
  }
}
