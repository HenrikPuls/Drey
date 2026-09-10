/**
 * The plugin manifest (`plugin.json`) and its pure validation.
 *
 * Deliberately tolerant on *content* and strict on *shape*: `version` is
 * not semver-policed (it is display text), but the id pattern is enforced
 * everywhere because the id is a path segment, an IPC namespace and a
 * config key. Nothing here throws — the host skips + logs a plugin whose
 * manifest is invalid.
 *
 * Shape validation only: the `apiVersion` gate against
 * `PLUGIN_API_VERSION.major` is the *host's* concern, so a manifest can be
 * validated without knowing the host version (unit-testable in isolation).
 */

/** The id is a folder name, an IPC namespace and a config key — keep it boring. */
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

/**
 * Declared, purely descriptive permissions — shown in Settings so the user
 * can see what a plugin touches. The trust model is in-process (ADR-0044):
 * nothing is enforced from these; they are documentation.
 */
export type PluginPermission =
  | 'documents'
  | 'vault'
  | 'editor'
  | 'commands'
  | 'settings'
  | 'llm'
  | 'main-process';

const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set<PluginPermission>([
  'documents',
  'vault',
  'editor',
  'commands',
  'settings',
  'llm',
  'main-process',
]);

export interface PluginManifest {
  /** Stable identifier, `PLUGIN_ID_PATTERN`. Must equal the plugin folder name. */
  readonly id: string;
  /** Display name (English, per the app's language convention). */
  readonly name: string;
  /** Plugin's own version — display text, not policed. */
  readonly version: string;
  /** Must equal `PLUGIN_API_VERSION.major` at load time or the plugin is `incompatible`. */
  readonly apiVersion: number;
  readonly description?: string;
  readonly author?: string;
  /** Main-process entry, relative to the plugin root (CommonJS), e.g. `main/index.js`. */
  readonly main?: string;
  /** Renderer entry, relative to the plugin root (ES module), e.g. `renderer/index.js`. */
  readonly renderer?: string;
  /** Stylesheets injected at activation, relative to the plugin root. */
  readonly css?: readonly string[];
  readonly permissions?: readonly PluginPermission[];
}

export type ManifestValidation = { manifest: PluginManifest } | { errors: string[] };

/**
 * Total shape check: returns every problem found, or the typed manifest.
 * Unknown extra keys are ignored (forward compatibility), unknown
 * permission names are an error (they are almost certainly a typo).
 */
export function validateManifest(raw: unknown): ManifestValidation {
  const errors: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { errors: ['manifest must be a JSON object'] };
  }
  const raw_ = raw as Record<string, unknown>;

  const id = raw_['id'];
  if (typeof id !== 'string' || !PLUGIN_ID_PATTERN.test(id)) {
    errors.push(`"id" must match ${PLUGIN_ID_PATTERN.source} (got ${JSON.stringify(id)})`);
  }

  const name = raw_['name'];
  if (typeof name !== 'string' || name.trim() === '') {
    errors.push('"name" must be a non-empty string');
  }

  const version = raw_['version'];
  if (typeof version !== 'string' || version.trim() === '') {
    errors.push('"version" must be a non-empty string');
  }

  const apiVersion = raw_['apiVersion'];
  if (typeof apiVersion !== 'number' || !Number.isInteger(apiVersion) || apiVersion < 1) {
    errors.push(`"apiVersion" must be a positive integer (got ${JSON.stringify(apiVersion)})`);
  }

  const description = raw_['description'];
  if (description !== undefined && typeof description !== 'string') {
    errors.push('"description" must be a string when present');
  }

  const author = raw_['author'];
  if (author !== undefined && typeof author !== 'string') {
    errors.push('"author" must be a string when present');
  }

  for (const entry of ['main', 'renderer'] as const) {
    const value = raw_[entry];
    if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
      errors.push(`"${entry}" must be a non-empty string when present`);
    }
  }

  const css = raw_['css'];
  if (css !== undefined) {
    if (!Array.isArray(css) || css.some((c) => typeof c !== 'string' || c.trim() === '')) {
      errors.push('"css" must be an array of non-empty strings when present');
    }
  }

  const permissions = raw_['permissions'];
  if (permissions !== undefined) {
    if (!Array.isArray(permissions)) {
      errors.push('"permissions" must be an array when present');
    } else {
      for (const p of permissions) {
        if (typeof p !== 'string' || !KNOWN_PERMISSIONS.has(p)) {
          errors.push(`unknown permission ${JSON.stringify(p)}`);
        }
      }
    }
  }

  if (errors.length > 0) {
    return { errors };
  }
  return {
    manifest: {
      id: id as string,
      name: name as string,
      version: version as string,
      apiVersion: apiVersion as number,
      ...(typeof description === 'string' ? { description } : {}),
      ...(typeof author === 'string' ? { author } : {}),
      ...(typeof raw_['main'] === 'string' ? { main: raw_['main'] as string } : {}),
      ...(typeof raw_['renderer'] === 'string' ? { renderer: raw_['renderer'] as string } : {}),
      ...(Array.isArray(css) ? { css: css as string[] } : {}),
      ...(Array.isArray(permissions) ? { permissions: permissions as PluginPermission[] } : {}),
    },
  };
}
