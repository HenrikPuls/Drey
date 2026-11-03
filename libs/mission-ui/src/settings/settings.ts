import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { THEME_LABEL, Theme } from '../theme';

/**
 * The settings screen's first cut (E12-2: the destination the navigation
 * needs; E12-3 fills it): the Appearance row carries the theme switch
 * that used to sit beside the bottom tab bar. Appearance is per device.
 */
@Component({
  selector: 'mc-settings',
  templateUrl: './settings.html',
  styleUrl: './settings.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Settings {
  private readonly theme = inject(Theme);

  /** The current theme's display name. */
  protected readonly themeLabel = () => THEME_LABEL[this.theme.name()];

  protected switchTheme(): void {
    this.theme.toggle();
  }
}
