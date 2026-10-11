/**
 * Local plugin installation from a .zip package (ADR-0068): the Settings →
 * Panels & plugins "Install from file…" flow and the matching Remove for
 * user-installed plugins.
 *
 * A package is the zip of a built plugin folder — `plugin.json` at the
 * archive root, exactly the layout `scripts/build-plugins.mjs` emits into
 * `dist-electron/plugins/<id>/` (see plugins/TUTORIAL.md). Install validates
 * the archive against the same rules discovery applies (manifest shape,
 * apiVersion major, safe entry paths), extracts into a staging folder under
 * the user root and swaps it into place, preserving the plugin's
 * `config.json` on upgrade. Like `plugins.disabled`, a change applies on
 * the next start — the Settings UI offers a relaunch.
 *
 * The trust model is unchanged from ADR-0044 (in-process, trusted): a
 * plugin package is code the user deliberately picked from their own disk,
 * so there is no signature and no sandbox — but validation refuses
 * everything that could not load anyway (wrong apiVersion, missing
 * entries) and every archive path that would leave the plugin folder
 * (zip-slip).
 *
 * The zip reader is a TypeScript twin of the dependency-free
 * central-directory reader in `scripts/fetch-drawio.mjs` (kept in sync by
 * eye; scripts are ESM and cannot import from `electron/`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { dialog, shell } from 'electron';
import { refocusRenderer } from '../focus';
import type { PluginHost } from './plugin-host';
import {
  PLUGIN_API_VERSION,
  validateManifest,
  type PluginManifest,
} from '../../shared/plugin-api';
import type { PluginInstallResult, PluginUninstallResult } from '../../shared/ipc-api';
import { isSafeEntryPath } from './plugin-discovery';

/** A plugin package is a convenience bundle, not a vendor image — bounded. */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;

/** Staging prefix under the user root; skipped by discovery (dot folder, no manifest). */
const STAGING_PREFIX = '.staging-';

export interface PluginInstallerDeps {
  /** `<userData>/plugins` — the user-installed discovery root (ADR-0044). */
  readonly userRoot: string;
  readonly pluginHost: PluginHost;
  readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

export class PluginInstaller {
  constructor(private readonly deps: PluginInstallerDeps) {}

  /** Native .zip pick; null when the user cancelled. */
  async pickArchive(): Promise<string | null> {
    const result = await dialog.showOpenDialog({
      title: 'Select a plugin package (.zip)',
      properties: ['openFile'],
      filters: [{ name: 'Drey plugin package', extensions: ['zip'] }],
    });
    refocusRenderer();
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0]!;
  }

  /**
   * Validates + installs a package. Never throws — every failure is a typed
   * `{ status: 'error' }` the Settings UI can show as-is.
   */
  async install(zipPath: string): Promise<PluginInstallResult> {
    let archive: Buffer;
    try {
      const stat = await fs.promises.stat(zipPath);
      if (!stat.isFile()) {
        return err('io', `"${path.basename(zipPath)}" is not a file.`);
      }
      if (stat.size > MAX_ARCHIVE_BYTES) {
        return err('too-large', `The package is larger than ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB.`);
      }
      archive = await fs.promises.readFile(zipPath);
    } catch (error) {
      return err('io', `Could not read "${path.basename(zipPath)}": ${asString(error)}`);
    }

    let entries: Array<{ name: string; data: Buffer }>;
    try {
      entries = [...readZipEntries(archive)];
    } catch (error) {
      return err('not-a-zip', `${path.basename(zipPath)}: ${asString(error)}`);
    }

    // Normalize separators (Windows PowerShell's Compress-Archive writes
    // backslash entry names), drop archive junk (Finder's __MACOSX and
    // resource forks, .DS_Store) and refuse everything that could leave the
    // plugin folder (zip-slip) or is malformed.
    const usable: Array<{ name: string; data: Buffer }> = [];
    for (const entry of entries) {
      const classification = classifyArchivePath(entry.name);
      if (classification === 'unsafe') {
        return err('unsafe-entry', `The package contains an unsafe path: "${entry.name}".`);
      }
      if (classification === 'ok') {
        usable.push({ name: entry.name.replace(/\\/g, '/'), data: entry.data });
      }
    }
    entries = usable;

    const manifestEntry = entries.find((e) => e.name === 'plugin.json');
    if (manifestEntry === undefined) {
      return err('no-manifest', 'The package has no plugin.json at the archive root.');
    }
    let rawManifest: unknown;
    try {
      rawManifest = JSON.parse(manifestEntry.data.toString('utf8'));
    } catch (error) {
      return err('invalid-manifest', `plugin.json is not valid JSON: ${asString(error)}`);
    }
    const validated = validateManifest(rawManifest);
    if ('errors' in validated) {
      return err('invalid-manifest', `plugin.json is invalid: ${validated.errors.join('; ')}`);
    }
    const manifest: PluginManifest = validated.manifest;

    if (manifest.apiVersion !== PLUGIN_API_VERSION.major) {
      return err(
        'api-version',
        `"${manifest.name}" targets plugin API ${manifest.apiVersion}, but this Drey has API ${PLUGIN_API_VERSION.major}.`,
      );
    }

    for (const ref of [manifest.main, manifest.renderer, ...(manifest.css ?? [])]) {
      if (ref !== undefined && !entries.some((e) => e.name === ref)) {
        return err('missing-entry', `The package is missing the manifest entry "${ref}".`);
      }
    }

    const discovered = this.deps.pluginHost.pluginById(manifest.id);
    if (discovered?.builtin === true) {
      return err(
        'builtin-collision',
        `"${manifest.id}" is a built-in plugin of this Drey and cannot be replaced.`,
      );
    }

    return this.extract(manifest, entries);
  }

  /** Moves validated entries into the user root, preserving config on upgrade. */
  private async extract(
    manifest: PluginManifest,
    entries: Array<{ name: string; data: Buffer }>,
  ): Promise<PluginInstallResult> {
    const target = path.join(this.deps.userRoot, manifest.id);
    const staging = path.join(this.deps.userRoot, `${STAGING_PREFIX}${manifest.id}`);
    const configPath = path.join(target, 'config.json');

    const previousConfig = await fs.promises
      .readFile(configPath, 'utf8')
      .catch(() => null);

    try {
      await fs.promises.rm(staging, { recursive: true, force: true });
      await fs.promises.mkdir(staging, { recursive: true });
      let total = 0;
      for (const entry of entries) {
        total += entry.data.length;
        if (total > MAX_UNCOMPRESSED_BYTES) {
          return err('too-large', 'The package expands beyond 1 GB.');
        }
        const file = path.join(staging, ...entry.name.split('/'));
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, entry.data);
      }
      if (previousConfig !== null) {
        await fs.promises.writeFile(path.join(staging, 'config.json'), previousConfig);
      }
      const upgraded = fs.existsSync(target);
      await fs.promises.rm(target, { recursive: true, force: true });
      await fs.promises.rename(staging, target);
      this.deps.log(
        `plugin package "${manifest.id}" v${manifest.version} installed to ${target}` +
          (previousConfig !== null ? ' (config preserved)' : ''),
      );
      return {
        status: 'installed',
        pluginId: manifest.id,
        pluginName: manifest.name,
        upgraded,
      };
    } catch (error) {
      await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      return err('io', `Installing "${manifest.name}" failed: ${asString(error)}`);
    }
  }

  /**
   * Removes a user-installed plugin (recycle bin first). Refuses built-in
   * ids — their `config.json` lives in the same tree and their code is not
   * here to remove.
   */
  async uninstall(pluginId: string): Promise<PluginUninstallResult> {
    const discovered = this.deps.pluginHost.pluginById(pluginId);
    if (discovered?.builtin === true) {
      return {
        status: 'error',
        reason: 'builtin',
        message: `"${pluginId}" is built into Drey and cannot be removed.`,
      };
    }
    const target = path.join(this.deps.userRoot, pluginId);
    if (!fs.existsSync(target)) {
      return {
        status: 'error',
        reason: 'not-found',
        message: `No installed plugin "${pluginId}" was found.`,
      };
    }
    try {
      await shell.trashItem(target).catch(() => fs.promises.rm(target, { recursive: true, force: true }));
    } catch (error) {
      return {
        status: 'error',
        reason: 'io',
        message: `Removing "${pluginId}" failed: ${asString(error)}`,
      };
    }
    this.deps.log(`plugin "${pluginId}" removed from ${target}`);
    return { status: 'removed', pluginId };
  }
}

/**
 * Archive-entry classification, stricter than `isSafeEntryPath` (which
 * governs manifest *references*): separators may be `/` or `\` (the
 * PowerShell interop wart), but a path must be plain and relative — no
 * absolute/drive forms, no `..`, no malformed `//`/`.` segments. Hidden
 * files and Finder's `__MACOSX` tree are junk, not grounds to refuse — a
 * plugin package has no legitimate use for either. Together with the
 * `plugin.json`-at-root rule this keeps every write inside the plugin
 * folder.
 */
function classifyArchivePath(name: string): 'ok' | 'junk' | 'unsafe' {
  if (name === '' || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
    return 'unsafe';
  }
  const segments = name.split(/[\\/]/);
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    return 'unsafe';
  }
  if (segments[0] === '__MACOSX' || segments.some((s) => s.startsWith('.'))) {
    return 'junk';
  }
  return 'ok';
}

/**
 * Central-directory zip reader (twin of `scripts/fetch-drawio.mjs`): file
 * entries as `{ name, data }`, stored or deflated, non-zip64. Throws on
 * anything else — the installer maps that to a typed error.
 */
function* readZipEntries(buffer: Buffer): Generator<{ name: string; data: Buffer }> {
  const END_SIGNATURE = 0x06054b50;
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== END_SIGNATURE) {
    end--;
  }
  if (end < 0) {
    throw new Error('not a zip archive (no end-of-central-directory record)');
  }
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('corrupt zip central directory');
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) {
      continue;
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressedSize);
    if (method !== 0 && method !== 8) {
      throw new Error(`unsupported zip compression method ${method} for ${name}`);
    }
    yield { name, data: method === 0 ? raw : inflateRawSync(raw) };
  }
}

function err(
  reason: Extract<PluginInstallResult, { status: 'error' }>['reason'],
  message: string,
): PluginInstallResult {
  return { status: 'error', reason, message };
}

function asString(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
