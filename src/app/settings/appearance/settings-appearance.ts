import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import {
  ACCENT_PRESETS,
  EDITOR_FONT_FAMILIES,
  THEME_ACCENT,
  UI_SCALE_LABELS,
  UiScale,
  resolveAccentHex,
} from '../../../../shared/app-config';
import { THEME_CATALOG } from '../../editor/themes/theme-catalog';
import { SettingsService } from '../../services/settings.service';
import { SettingsPane } from '../settings-pane/settings-pane';

@Component({
  selector: 'app-settings-appearance',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsPane],
  templateUrl: './settings-appearance.html',
  styleUrls: ['../settings-forms.css', './settings-appearance.css'],
})
export class SettingsAppearance {
  protected readonly settings = inject(SettingsService);
  protected readonly fontFamilies = EDITOR_FONT_FAMILIES;
  protected readonly accents = ACCENT_PRESETS;
  protected readonly themeAccent = THEME_ACCENT;
  protected readonly scaleSteps = (Object.keys(UI_SCALE_LABELS) as UiScale[]).map((id) => ({
    id,
    label: UI_SCALE_LABELS[id],
  }));

  /** The theme catalog grouped for the picker's `<optgroup>`s. */
  protected readonly themeGroups = (['Drey', 'Dark', 'Light'] as const).map((group) => ({
    group,
    entries: THEME_CATALOG.filter((entry) => entry.group === group),
  }));

  /** The active theme's seed accent -- what `'theme'` resolves to. */
  private readonly seedAccent = computed(
    () => THEME_CATALOG.find((e) => e.id === this.settings.appearanceTheme())?.seed.accent,
  );

  /** The concrete hex for the current accent -- seeds the custom colour input. */
  protected readonly accentHex = computed(() =>
    resolveAccentHex(this.settings.appearanceAccent(), this.seedAccent()),
  );

  /** The theme's own accent hex -- the swatch for the `'theme'` option. */
  protected readonly seedAccentHex = computed(() =>
    resolveAccentHex(THEME_ACCENT, this.seedAccent()),
  );

  /** True when the accent is a custom hex rather than a preset or the theme sentinel. */
  protected readonly accentIsCustom = computed(() => {
    const accent = this.settings.appearanceAccent();
    return accent !== THEME_ACCENT && !this.accents.some((preset) => preset.id === accent);
  });

  protected onThemeChange(id: string): void {
    this.settings.setAppearanceTheme(id);
  }

  protected onFontFamilyChange(id: string): void {
    this.settings.setEditorFontFamily(id);
  }

  protected onScaleChange(id: string): void {
    this.settings.setAppearanceUiScale(id);
  }

  protected onAccentChange(value: string): void {
    this.settings.setAppearanceAccent(value);
  }
}
