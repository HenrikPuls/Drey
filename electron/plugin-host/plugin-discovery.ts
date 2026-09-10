/**
 * Plugin discovery: find `plugin.json` folders, validate, dedupe, and
 * resolve enable state. Pure fs + config reads — no code is imported here
 * (`PluginHost` activates).
 *
 * Roots, in precedence order (ADR-0044):
 * - built-ins: `<dist-electron>/plugins/<id>/` — shipped with the app,
 *   treated identically to user plugins everywhere else;
 * - user-installed: `<userData>/plugins/<id>/`;
 * - dev/test extra: `DREY_EXTRA_PLUGIN_DIR` (one extra root, e.g. an e2e
 *   fixture). Lower precedence than the user dir.
 *
 * A folder whose manifest is invalid, or whose folder name disagrees with
 * the manifest id, is skipped and logged — discovery never throws.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PLUGIN_API_VERSION,
  PLUGIN_ID_PATTERN,
  validateManifest,
  type PluginManifest,
  type PluginStatus,
} from '../../shared/plugin-api';
import type { PluginsConfig } from '../../shared/config/schema';

/** A plugin that survived discovery. `rootDir` holds `plugin.json` + entries. */
export interface DiscoveredPlugin {
  readonly manifest: PluginManifest;
  readonly rootDir: string;
  /** True when it came from the bundled root (not user-installed). */
  readonly builtin: boolean;
  readonly status: PluginStatus;
  /** Quarantine reason for `incompatible` / `failed`; unset otherwise. */
  readonly error?: string;
}

/** A manifest entry path must stay inside the plugin root: relative, POSIX, no `..`. */
export function isSafeEntryPath(value: string): boolean {
  if (value === '' || value.startsWith('/') || value.startsWith('\\')) {
    return false;
  }
  if (/^[a-zA-Z]:/.test(value)) {
    return false;
  }
  const segments = value.split(/[/\\]/);
  return segments.every((s) => s !== '' && s !== '.' && s !== '..');
}

export interface DiscoveryInput {
  /** Absolute path of the bundled plugins root (`<dist-electron>/plugins`). */
  readonly builtinRoot: string;
  /** Absolute path of `<userData>/plugins`. */
  readonly userRoot: string;
  /** Extra dev/test root, or null. */
  readonly extraRoot: string | null;
  readonly pluginsConfig: PluginsConfig;
  readonly log: (message: string) => void;
}

/**
 * Scan the roots and return the discovered plugins, built-in-wins on id
 * collisions, in stable (root, then folder-name) order.
 */
export async function discoverPlugins(input: DiscoveryInput): Promise<DiscoveredPlugin[]> {
  const byId = new Map<string, DiscoveredPlugin>();
  const roots: Array<{ dir: string; builtin: boolean }> = [
    { dir: input.builtinRoot, builtin: true },
    { dir: input.userRoot, builtin: false },
  ];
  if (input.extraRoot !== null && input.extraRoot !== '') {
    roots.push({ dir: input.extraRoot, builtin: false });
  }

  for (const root of roots) {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(root.dir);
    } catch {
      continue; // Root missing (e.g. no user plugins yet) — normal.
    }
    for (const folder of entries.sort()) {
      const rootDir = path.join(root.dir, folder);
      const loaded = await loadManifest(rootDir, input.log);
      if (loaded === null) {
        continue;
      }
      const manifest = loaded;
      if (manifest.id !== folder) {
        input.log(
          `plugin: skipping ${rootDir} — manifest id "${manifest.id}" does not match folder name "${folder}"`,
        );
        continue;
      }
      const existing = byId.get(manifest.id);
      if (existing !== undefined) {
        // A discovered duplicate: the earlier root wins (built-in over user).
        input.log(
          `plugin: duplicate id "${manifest.id}" at ${rootDir} — keeping ${existing.rootDir}`,
        );
        continue;
      }
      byId.set(manifest.id, { manifest, rootDir, builtin: root.builtin, status: 'active' });
    }
  }

  // Resolve the gate + enable state in one pass over the survivors.
  const out: DiscoveredPlugin[] = [];
  for (const plugin of byId.values()) {
    if (input.pluginsConfig.disabled.includes(plugin.manifest.id)) {
      out.push({ ...plugin, status: 'disabled' });
      continue;
    }
    if (plugin.manifest.apiVersion !== PLUGIN_API_VERSION.major) {
      out.push({
        ...plugin,
        status: 'incompatible',
        error: `plugin api version ${plugin.manifest.apiVersion} does not match app api version ${PLUGIN_API_VERSION.major}`,
      });
      continue;
    }
    out.push({ ...plugin, status: 'active' });
  }
  return out;
}

/** Reads + validates `plugin.json` in `rootDir`; null (with a log line) when unusable. */
async function loadManifest(rootDir: string, log: (m: string) => void): Promise<PluginManifest | null> {
  const manifestPath = path.join(rootDir, 'plugin.json');
  let raw: string;
  try {
    raw = await fs.promises.readFile(manifestPath, 'utf8');
  } catch {
    return null; // Not a plugin folder (or unreadable) — silent, roots contain other things too.
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log(`plugin: ${manifestPath} is not valid JSON: ${String(error)}`);
    return null;
  }
  const result = validateManifest(parsed);
  if ('errors' in result) {
    log(`plugin: ${manifestPath} rejected: ${result.errors.join('; ')}`);
    return null;
  }
  for (const entry of [result.manifest.main, ...(result.manifest.css ?? [])]) {
    if (entry !== undefined && !isSafeEntryPath(entry)) {
      log(`plugin: ${manifestPath} has an unsafe entry path "${entry}"`);
      return null;
    }
  }
  if (result.manifest.renderer !== undefined && !isSafeEntryPath(result.manifest.renderer)) {
    log(`plugin: ${manifestPath} has an unsafe renderer path "${result.manifest.renderer}"`);
    return null;
  }
  return result.manifest;
}

/** Guard re-exported for the IPC router's id validation. */
export const pluginIdPattern = PLUGIN_ID_PATTERN;
