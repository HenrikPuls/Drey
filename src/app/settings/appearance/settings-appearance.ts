import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import {
  ACCENT_PRESETS,
  EDITOR_FONT_FAMILIES,
  UI_SCALE_LABELS,
  UiScale,
  resolveAccentHex,
} from '../../../../shared/app-config';
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
  protected readonly scaleSteps = (Object.keys(UI_SCALE_LABELS) as UiScale[]).map((id) => ({
    id,
    label: UI_SCALE_LABELS[id],
  }));

  /** The concrete hex for the current accent -- seeds the custom colour input. */
  protected readonly accentHex = computed(() => resolveAccentHex(this.settings.appearanceAccent()));

  /** True when the accent is a custom hex rather than one of the presets. */
  protected readonly accentIsCustom = computed(
    () => !this.accents.some((preset) => preset.id === this.settings.appearanceAccent()),
  );

  protected onFontFamilyChange(id: string): void {
    void this.settings.setEditorFontFamily(id);
  }

  protected onScaleChange(id: string): void {
    void this.settings.setAppearanceUiScale(id);
  }

  protected onAccentChange(value: string): void {
    void this.settings.setAppearanceAccent(value);
  }
}
