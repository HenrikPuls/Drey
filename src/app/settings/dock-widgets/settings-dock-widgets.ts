import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { WidgetRegistryService } from '../../dock';
import { WIDGET_CAPABILITY_LABELS } from '../../widgets';
import { ConfirmDialogService } from '../../services/confirm-dialog.service';
import { PluginCatalogService } from '../../services/plugin-catalog.service';
import { SettingsService } from '../../services/settings.service';
import { SettingsPane } from '../settings-pane/settings-pane';

/**
 * "Panels & plugins" settings category: switch a dock panel (ADR-0034) or a
 * whole plugin (ADR-0044) off. A disabled panel leaves every dock *and* the
 * View menu; a disabled plugin is never discovered again after a restart.
 * The dock reconciles as soon as the toggle is saved; plugin toggles apply
 * on the next app start. A plugin's status line is what the
 * host last saw (active / failed / incompatible / disabled); failed and
 * incompatible ones show the host's error.
 *
 * Local plugin packages (ADR-0068): "Install from file…" picks a .zip,
 * main validates + installs it under `<userData>/plugins/`, "Remove"
 * deletes a user-installed one. Both apply on the next start — the offer
 * to relaunch rides the shared in-renderer dialog.
 */
@Component({
  selector: 'app-settings-dock-widgets',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsPane],
  templateUrl: './settings-dock-widgets.html',
  styleUrls: ['./settings-dock-widgets.css'],
})
export class SettingsDockWidgets {
  protected readonly settings = inject(SettingsService);
  private readonly widgets = inject(WidgetRegistryService);
  private readonly catalog = inject(PluginCatalogService);
  private readonly dialogs = inject(ConfirmDialogService);

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
    return this.catalog.plugins().map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      source: p.builtin ? 'built-in' : 'installed',
      builtin: p.builtin,
      permissions: p.permissions.join(', '),
      status: p.status,
      error: p.error,
      enabled: !disabled.has(p.id),
    }));
  });

  /** A package was installed or removed — the next start applies it (ADR-0068). */
  protected readonly restartPending = this.catalog.pluginChangePending;

  /** Guards against stacking native pick dialogs on a double click. */
  protected readonly installBusy = signal(false);

  protected onToggle(id: string, enabled: boolean): void {
    this.settings.setWidgetEnabled(id, enabled);
  }

  protected onPluginToggle(id: string, enabled: boolean): void {
    this.settings.setPluginEnabled(id, enabled);
  }

  protected async onInstallFromFile(): Promise<void> {
    if (this.installBusy()) {
      return;
    }
    this.installBusy.set(true);
    try {
      const result = await this.catalog.installPluginFromFile();
      if (result === null) {
        return; // pick cancelled
      }
      if (result.status === 'error') {
        await this.dialogs.message({ title: 'Install plugin', message: result.message });
        return;
      }
      await this.offerRestart(
        result.upgraded
          ? `"${result.pluginName}" was updated. Restart Drey to load the new version.`
          : `"${result.pluginName}" was installed. Restart Drey to activate it.`,
      );
    } finally {
      this.installBusy.set(false);
    }
  }

  protected async onRemovePlugin(id: string, name: string): Promise<void> {
    const confirmed = await this.dialogs.confirm({
      title: 'Remove plugin',
      message: `Remove "${name}"? Its files are deleted from this computer's Drey plugin folder.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    const result = await this.catalog.removePlugin(id);
    if (result.status === 'error') {
      await this.dialogs.message({ title: 'Remove plugin', message: result.message });
      return;
    }
    await this.offerRestart(`"${name}" was removed. Restart Drey to finish.`);
  }

  protected restartNow(): void {
    this.catalog.relaunchApp();
  }

  private async offerRestart(message: string): Promise<void> {
    const restart = await this.dialogs.confirm({
      title: 'Restart required',
      message,
      confirmLabel: 'Restart now',
      cancelLabel: 'Later',
    });
    if (restart) {
      this.restartNow();
    }
  }
}
