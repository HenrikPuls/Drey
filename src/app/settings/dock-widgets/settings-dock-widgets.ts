import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { WidgetRegistryService } from '../../dock';
import { WIDGET_CAPABILITY_LABELS } from '../../widgets';
import { PluginHostService } from '../../plugin-host';
import { SettingsService } from '../../services/settings.service';
import { SettingsPane } from '../settings-pane/settings-pane';

/**
 * "Panels & plugins" settings category: switch a dock panel (ADR-0034) or a
 * whole plugin (ADR-0044) off. A disabled panel leaves every dock *and* the
 * View menu; a disabled plugin is never discovered again after a restart.
 * Draft edit like every other category; the dock reconciles on Save, plugin
 * toggles apply on the next app start. A plugin's status line is what the
 * host last saw (active / failed / incompatible / disabled); failed and
 * incompatible ones show the host's error.
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
  private readonly widgets = inject(WidgetRegistryService);
  private readonly pluginHost = inject(PluginHostService);

  /** Every registered widget, with its resolved enabled state + capability labels. */
  protected readonly rows = computed(() => {
    const disabled = this.settings.widgetsDisabledDraft();
    return this.widgets.widgets().map((w) => ({
      id: w.id,
      title: w.title,
      removable: w.removable,
      enabled: !disabled.has(w.id),
      capabilities: w.capabilities.map((c) => WIDGET_CAPABILITY_LABELS[c]).join(' · '),
    }));
  });

  /** Every discovered plugin, with its live status + draft enable state. */
  protected readonly pluginRows = computed(() => {
    const disabled = this.settings.pluginsDisabledDraft();
    return this.pluginHost.plugins().map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      source: p.builtin ? 'built-in' : 'installed',
      permissions: p.permissions.join(', '),
      status: p.status,
      error: p.error,
      enabled: !disabled.has(p.id),
    }));
  });

  protected onToggle(id: string, enabled: boolean): void {
    this.settings.setWidgetEnabled(id, enabled);
  }

  protected onPluginToggle(id: string, enabled: boolean): void {
    this.settings.setPluginEnabled(id, enabled);
  }
}
