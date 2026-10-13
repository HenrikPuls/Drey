import { Injectable, signal } from '@angular/core';
import type { PluginDescriptorForRenderer } from '../../../shared/plugin-api/renderer';
import type { PluginInstallResult, PluginUninstallResult } from '../../../shared/ipc-api';

/**
 * What the app knows about its plugins as a list: every discovered plugin
 * with its status, and installing / removing local packages (ADR-0068).
 *
 * Kept apart from `PluginHostService` so that Settings → Panels & plugins
 * can show and manage the list without importing the host that loads the
 * plugins — the host imports the settings registry, and the other
 * direction would close a cycle. `PluginHostService` writes `plugins`.
 */
@Injectable({ providedIn: 'root' })
export class PluginCatalogService {
  /** Every discovered plugin with its status; Settings → Panels & plugins reads this. */
  readonly plugins = signal<readonly PluginDescriptorForRenderer[]>([]);

  /**
   * True once a plugin package was installed or removed this session — the
   * change applies on the next start, so Settings keeps offering a restart
   * until one happens.
   */
  readonly pluginChangePending = signal(false);

  /** Native .zip pick + install; null when the pick was cancelled. */
  async installPluginFromFile(): Promise<PluginInstallResult | null> {
    const picked = await window.dreyApi.pickPluginPackage();
    if (picked === null) {
      return null;
    }
    const result = await window.dreyApi.installPluginPackage(picked);
    if (result.status === 'installed') {
      this.pluginChangePending.set(true);
    }
    return result;
  }

  /** Removes a user-installed plugin (the caller confirms first). */
  async removePlugin(pluginId: string): Promise<PluginUninstallResult> {
    const result = await window.dreyApi.uninstallPlugin(pluginId);
    if (result.status === 'removed') {
      this.pluginChangePending.set(true);
    }
    return result;
  }

  /** Graceful restart (dirty tabs still get their exit prompt). */
  relaunchApp(): void {
    void window.dreyApi.relaunchApp();
  }
}
