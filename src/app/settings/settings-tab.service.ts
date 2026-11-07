import {
  ApplicationRef,
  EnvironmentInjector,
  Injectable,
  createComponent,
  inject,
} from '@angular/core';
import { DocKindRegistry } from '../plugin-host';
import { EditorService } from '../services/editor.service';
import { SettingsService } from '../services/settings.service';
import { Settings } from './settings';
import { SETTINGS_DOC_KIND, SETTINGS_DOC_KEY } from './settings-doc';

/**
 * Settings as an editor tab (board 7g; ADR-0010 later change, milestone 197).
 * A core doc kind on the `DocKindRegistry` seam the plugin tabs use: the tab
 * is titled "Settings", there is one instance (opening it again focuses it),
 * the session restores its presence and nothing else, and the pane body is the
 * `Settings` component mounted into the pane's own element.
 *
 * Every entry point (status-bar entry, File menu, `Mod+,`, Help -> About) calls
 * {@link open}; the status bar, menu and command never mount anything themselves.
 */
@Injectable({ providedIn: 'root' })
export class SettingsTabService {
  private readonly editor = inject(EditorService);
  private readonly settings = inject(SettingsService);
  private readonly appRef = inject(ApplicationRef);
  private readonly environment = inject(EnvironmentInjector);

  constructor() {
    inject(DocKindRegistry).register({
      kind: SETTINGS_DOC_KIND,
      serialize: () => null,
      restore: () => this.open(),
      mount: (el) => this.mount(el),
      statusText: () => 'Settings',
    });
  }

  /** Opens the Settings tab, or focuses it; `category` names the page to show (Help -> About). */
  open(category?: string): void {
    if (category !== undefined) {
      this.settings.openCategory.set(category);
    }
    this.editor.addPluginDoc(SETTINGS_DOC_KIND, SETTINGS_DOC_KEY, 'Settings');
  }

  private mount(el: HTMLElement): () => void {
    const host = document.createElement('app-settings');
    host.style.display = 'flex';
    host.style.flex = '1';
    host.style.minWidth = '0';
    host.style.minHeight = '0';
    el.append(host);
    const ref = createComponent(Settings, { environmentInjector: this.environment, hostElement: host });
    this.appRef.attachView(ref.hostView);
    ref.changeDetectorRef.detectChanges();
    return () => {
      this.appRef.detachView(ref.hostView);
      ref.destroy();
      host.remove();
    };
  }
}
