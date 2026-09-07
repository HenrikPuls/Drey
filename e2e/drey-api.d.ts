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
  listVaultFiles(): Promise<
    Array<{ name: string; relativePath: string; type: 'file' | 'directory' }>
  >;
}

interface Window {
  dreyApi: DreyApiForE2E;
}
