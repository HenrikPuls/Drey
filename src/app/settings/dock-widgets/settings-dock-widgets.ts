import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { WIDGETS } from '../../dock';
import { WIDGET_CAPABILITY_LABELS } from '../../widgets';
import { SettingsService } from '../../services/settings.service';
import { SettingsPane } from '../settings-pane/settings-pane';

/**
 * "Widgets" settings category (ADR-0034): switch a dock widget off
 * entirely -- it leaves every dock *and* the View menu, and its component
 * is never instantiated. Draft edit like every other category; the dock
 * reconciles on Save. The capability line is descriptive (no runtime
 * gating).
 */
@Component({
  selector: 'app-settings-dock-widgets',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsPane],
  templateUrl: './settings-dock-widgets.html',
  styleUrls: ['../settings-forms.css', './settings-dock-widgets.css'],
})
export class SettingsDockWidgets {
  protected readonly settings = inject(SettingsService);

  /** Every registered widget, with its resolved enabled state + capability labels. */
  protected readonly rows = computed(() => {
    const disabled = this.settings.widgetsDisabledDraft();
    return WIDGETS.map((w) => ({
      id: w.id,
      title: w.title,
      removable: w.removable,
      enabled: !disabled.has(w.id),
      capabilities: w.capabilities.map((c) => WIDGET_CAPABILITY_LABELS[c]).join(' · '),
    }));
  });

  protected onToggle(id: string, enabled: boolean): void {
    this.settings.setWidgetEnabled(id, enabled);
  }
}
