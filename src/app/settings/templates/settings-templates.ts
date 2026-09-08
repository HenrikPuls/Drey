import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { SettingsService } from '../../services/settings.service';
import { SettingsPane } from '../settings-pane/settings-pane';

/**
 * "Templates" settings category. One field: the vault-relative folder whose
 * `.md` files back the Templates panel and the Ctrl+T picker.
 *
 * The value is normalised on the Save round-trip (`normalizeTemplatesConfig`
 * in `shared/app-config.ts`) -- trimmed, slashes folded, no `..` -- so the
 * input here is a plain text field with no live validation.
 *
 * Pure view; the change goes into the draft and reaches disk on Save.
 */
@Component({
  selector: 'app-settings-templates',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsPane],
  templateUrl: './settings-templates.html',
  styleUrls: ['../settings-forms.css'],
})
export class SettingsTemplates {
  protected readonly settings = inject(SettingsService);

  protected readonly templates = computed(() => this.settings.draft()?.templates ?? null);

  protected onDirChange(dir: string): void {
    this.settings.patchTemplates({ dir });
  }
}
