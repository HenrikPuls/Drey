import { Injectable, signal } from '@angular/core';
import { AppInfo } from '../../../shared/ipc-api';

/** One production dependency, as written to `src/assets/licenses.json` by
 *  `scripts/generate-licenses.mjs`. */
export interface LicenseEntry {
  name: string;
  version: string;
  /** SPDX id, or `"a OR b"` when the package declares several. */
  license: string;
  repository: string | null;
  publisher: string | null;
  /** Full license file text, or `""` when the package shipped none. */
  licenseText: string;
}

interface LicenseManifest {
  count: number;
  packages: LicenseEntry[];
}

/**
 * Backs the "About" settings pane. Two independent sources:
 * - runtime versions from the main process (`app:get-info` IPC), and
 * - the bundled `assets/licenses.json` (generated at build time from the
 *   production dependency tree, not something the main process serves).
 *
 * All logic lives here, not in the pane component (CLAUDE.md, "no business
 * logic inside components").
 */
@Injectable({ providedIn: 'root' })
export class AboutService {
  readonly appInfo = signal<AppInfo | null>(null);
  readonly licenses = signal<readonly LicenseEntry[]>([]);
  /** Set when `licenses.json` could not be read -- shown instead of a bare empty list. */
  readonly licensesError = signal<string | null>(null);

  /** True once the manifest has been read successfully (an empty list is still "read"). */
  private licensesFetched = false;

  private get api() {
    return typeof window !== 'undefined' ? window.dreyApi : undefined;
  }

  /** Idempotent per source: only the parts that have not loaded yet re-fetch. */
  async load(): Promise<void> {
    const tasks: Promise<void>[] = [];
    if (this.appInfo() === null) {
      tasks.push(this.loadAppInfo());
    }
    if (!this.licensesFetched) {
      tasks.push(this.loadLicenses());
    }
    await Promise.all(tasks);
  }

  private async loadAppInfo(): Promise<void> {
    if (!this.api) {
      return;
    }
    try {
      this.appInfo.set(await this.api.getAppInfo());
    } catch {
      this.appInfo.set(null);
    }
  }

  private async loadLicenses(): Promise<void> {
    try {
      const response = await fetch('assets/licenses.json');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const manifest = (await response.json()) as LicenseManifest;
      this.licenses.set(manifest.packages ?? []);
      this.licensesError.set(null);
      this.licensesFetched = true;
    } catch (err) {
      this.licenses.set([]);
      this.licensesError.set(err instanceof Error ? err.message : String(err));
    }
  }
}
