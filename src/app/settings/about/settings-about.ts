import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { AboutService } from '../../services/about.service';
import { SettingsPane } from '../settings-pane/settings-pane';

/**
 * "About" settings category: the running app / Electron / Chromium / Node
 * versions (from the `app:get-info` IPC) and the list of bundled
 * open-source dependencies with their licenses (from `assets/licenses.json`).
 *
 * Read-only -- it never touches `SettingsService.draft`, so it adds no
 * dirty state and cannot affect Save.
 */
@Component({
  selector: 'app-settings-about',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsPane],
  templateUrl: './settings-about.html',
  styleUrls: ['../settings-forms.css', './settings-about.css'],
})
export class SettingsAbout implements OnInit {
  protected readonly about = inject(AboutService);

  ngOnInit(): void {
    void this.about.load();
  }
}
