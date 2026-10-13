import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { AboutService } from '../../services/about.service';
import { ThemeService } from '../../services/theme.service';
import { SettingsPane } from '../settings-pane/settings-pane';

/**
 * "About" settings category: the running app / Electron / Chromium / Node
 * versions (from the `app:get-info` IPC) and the list of bundled
 * open-source dependencies with their licenses (from `assets/licenses.json`).
 *
 * Read-only -- it never touches `SettingsService.draft`.
 */
@Component({
  selector: 'app-settings-about',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsPane],
  templateUrl: './settings-about.html',
  styleUrls: ['./settings-about.css'],
})
export class SettingsAbout implements OnInit {
  protected readonly about = inject(AboutService);
  protected readonly theme = inject(ThemeService);

  ngOnInit(): void {
    void this.about.load();
  }
}
