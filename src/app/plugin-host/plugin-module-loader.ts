import { InjectionToken, inject } from '@angular/core';

/**
 * Loads a plugin's renderer ES module. Isolated behind a token (ADR-0044
 * risk R1): this is the ONE place a cross-origin dynamic `import()` of a
 * `plugin://` URL happens, so a fallback loader (same-origin mapping) can
 * replace it without touching the host, and a test can fake it.
 */
export interface PluginModuleLoader {
  load(url: string): Promise<unknown>;
}

/** The real loader: a dynamic import the bundler cannot statically rewrite. */
export class DynamicImportLoader implements PluginModuleLoader {
  load(url: string): Promise<unknown> {
    return import(/* webpackIgnore: true */ url);
  }
}

export const PLUGIN_MODULE_LOADER = new InjectionToken<PluginModuleLoader>('PluginModuleLoader', {
  providedIn: 'root',
  factory: () => new DynamicImportLoader(),
});

/** Resolves the ES module shape: a CJS-style default export wins, else the namespace. */
export function moduleDefault(imported: unknown): unknown {
  const candidate = imported as { default?: unknown } | null;
  if (
    candidate !== null &&
    typeof candidate === 'object' &&
    'default' in candidate &&
    candidate.default !== undefined
  ) {
    return candidate.default;
  }
  return imported;
}
