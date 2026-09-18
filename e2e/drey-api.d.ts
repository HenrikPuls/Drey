/**
 * Minimal ambient view of the preload bridge for E2E `page.evaluate`
 * callbacks. This is intentionally a hand-written subset -- only the
 * members the tests touch -- so the E2E project stays decoupled from the
 * renderer's own `Window` augmentation in `src/`. Widen as tests grow.
 */
interface DreyApiForE2E {
  getAppInfo(): Promise<{
    appVersion: string;
    electronVersion: string;
    nodeVersion: string;
    chromeVersion: string;
    platform: string;
  }>;
  getActiveVault(): Promise<string | null>;
  listVaults(): Promise<
    Array<{ id: string; name: string; path: string; exists: boolean; active: boolean }>
  >;
  saveVaultAsset(
    bytes: Uint8Array,
    ext: string,
    noteRelPath: string,
    vaultId?: string,
    preferredName?: string,
  ): Promise<string>;
  listVaultFiles(): Promise<
    Array<{ name: string; relativePath: string; type: 'file' | 'directory' }>
  >;
  listPlugins(): Promise<
    Array<{
      id: string;
      name: string;
      version: string;
      status: 'active' | 'incompatible' | 'failed' | 'disabled';
      error?: string;
      rendererUrl?: string;
      builtin: boolean;
    }>
  >;
  invokePlugin(pluginId: string, method: string, payload?: unknown): Promise<unknown>;
}

interface Window {
  dreyApi: DreyApiForE2E;
}
