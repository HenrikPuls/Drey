import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { EDITOR_FONT_FAMILIES } from '../../../../shared/app-config';
import { SettingsService } from '../../services/settings.service';

/**
 * "Appearance" settings category. One control today: the document editor's
 * typeface (body + headings, Live Preview and source alike).
 *
 * Like the editor zoom, the choice persists immediately through
 * `SettingsService.setEditorFontFamily` -- it is applied to the editor host
 * on the next frame and does not go through the draft / Save flow, so
 * changing it here never marks the Settings screen dirty.
 */
@Component({
  selector: 'app-settings-appearance',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings-appearance.html',
  styleUrl: './settings-appearance.css',
})
export class SettingsAppearance {
  protected readonly settings = inject(SettingsService);
  protected readonly fontFamilies = EDITOR_FONT_FAMILIES;

  protected onFontFamilyChange(id: string): void {
    void this.settings.setEditorFontFamily(id);
  }
}
