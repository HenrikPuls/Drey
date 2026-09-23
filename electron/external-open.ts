import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { ExternalFileContent, OpenRequest } from '../shared/ipc-api';
import { isExternalOpenPath } from '../shared/external-open';

/** Larger files are refused -- an external tab is a viewer, not a hex editor. */
export const MAX_EXTERNAL_FILE_BYTES = 50 * 1024 * 1024;

/**
 * The Markdown / text files an OS launch asks Drey to open: every argv entry
 * that is not a switch, has a registered extension and is an existing file,
 * made absolute against `cwd`, de-duplicated, in order.
 *
 * `argv` is the raw `process.argv` of the launch (also what `second-instance`
 * delivers). Packaged, entry 0 is the exe; in dev (`electron .`) entry 1 is
 * the app path as well. Chromium / Playwright switches start with `-` and are
 * skipped; anything else has to survive the extension and stat checks, so a
 * stray switch *value* can never open anything.
 */
export function extractOpenPaths(
  argv: readonly string[],
  options: { isPackaged: boolean; cwd: string },
): string[] {
  const found: string[] = [];
  for (const arg of argv.slice(options.isPackaged ? 1 : 2)) {
    if (arg.startsWith('-') || !isExternalOpenPath(arg)) {
      continue;
    }
    const absolute = path.resolve(options.cwd, arg);
    try {
      if (!fs.statSync(absolute).isFile()) {
        continue;
      }
    } catch {
      continue;
    }
    if (!found.includes(absolute)) {
      found.push(absolute);
    }
  }
  return found;
}

/** The registry facts the gate needs -- `VaultManager.listVaults()` satisfies it. */
export interface VaultRoot {
  readonly id: string;
  readonly path: string;
}

/** Resolves symlinks / 8.3 names when the path exists, else just normalises. */
function canonical(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * The registered vault `absolutePath` sits in (the deepest one when vaults
 * nest) and its vault-relative forward-slash path, or `null` when it sits in
 * none. `path.relative` compares case-insensitively on win32, which is what
 * the containment test needs; the relative remainder keeps the file's real
 * casing.
 */
export function locateInVaults(
  vaults: readonly VaultRoot[],
  absolutePath: string,
): { vaultId: string; path: string } | null {
  const target = canonical(absolutePath);
  let best: { vaultId: string; rootLength: number; path: string } | null = null;
  for (const vault of vaults) {
    const root = canonical(vault.path);
    const relative = path.relative(root, target);
    if (
      relative === '' ||
      relative === '..' ||
      relative.startsWith('..' + path.sep) ||
      path.isAbsolute(relative)
    ) {
      continue;
    }
    if (best === null || root.length > best.rootLength) {
      best = { vaultId: vault.id, rootLength: root.length, path: relative.split(path.sep).join('/') };
    }
  }
  return best === null ? null : { vaultId: best.vaultId, path: best.path };
}

/** Case-insensitive on win32, exact elsewhere -- the allowlist's identity. */
function allowKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Where files the OS hands to Drey wait, and the only door through which the
 * renderer can read an out-of-vault file (ADR-0054).
 *
 * Launch argv / `second-instance` paths arrive via {@link enqueue}. Until the
 * renderer has pulled once ({@link takePending}) they queue -- a push at
 * cold start would fire before its listener exists, and classification needs
 * the vault registry, which only exists after startup. After the first pull
 * the gate is `ready` and every later `enqueue` classifies and pushes
 * straight away through `send`.
 *
 * Classification puts a path inside a registered vault as an ordinary vault
 * open; anything else becomes an `external` request and joins the read
 * allowlist. The allowlist is what keeps `read` from being an arbitrary file
 * read: the renderer can only ever read a path main itself collected from the
 * OS, with a registered extension, under the size cap.
 */
export class ExternalFileGate {
  private queued: string[] = [];
  private ready = false;
  private readonly allowed = new Set<string>();

  constructor(
    private readonly getVaults: () => readonly VaultRoot[],
    private readonly send: (requests: OpenRequest[]) => void,
    private readonly maxBytes: number = MAX_EXTERNAL_FILE_BYTES,
  ) {}

  /** Files from a launch: queued before the renderer is ready, pushed after. */
  enqueue(absolutePaths: readonly string[]): void {
    if (absolutePaths.length === 0) {
      return;
    }
    if (this.ready) {
      this.send(this.classifyAll(absolutePaths));
    } else {
      this.queued.push(...absolutePaths);
    }
  }

  /** The renderer's cold-start pull: drains the queue and marks it ready. */
  takePending(): OpenRequest[] {
    this.ready = true;
    const pending = this.classifyAll(this.queued);
    this.queued = [];
    return pending;
  }

  /** Throws unless `absolutePath` is a path main collected from the OS itself. */
  private assertAllowed(absolutePath: string, verb: 'read' | 'written'): void {
    if (!this.allowed.has(allowKey(absolutePath)) || !isExternalOpenPath(absolutePath)) {
      throw new Error(`This file was not opened from the operating system and cannot be ${verb}.`);
    }
  }

  /** Reads an allowlisted external file; rejects everything else. */
  async read(absolutePath: string): Promise<ExternalFileContent> {
    this.assertAllowed(absolutePath, 'read');
    const stat = await fsp.stat(absolutePath);
    if (!stat.isFile()) {
      throw new Error('Not a file.');
    }
    if (stat.size > this.maxBytes) {
      throw new Error(
        `File is larger than ${Math.round(this.maxBytes / (1024 * 1024))} MB and cannot be opened.`,
      );
    }
    const content = await fsp.readFile(absolutePath, 'utf-8');
    return { content, modifiedMs: stat.mtimeMs };
  }

  /**
   * Saves an allowlisted external file back to where it lives (the editable
   * external tab's Ctrl+S). Only the exact paths the OS handed over are
   * writable -- never a sibling, never a renderer-chosen path -- and the same
   * size cap as `read` applies. The file must still exist: a file deleted
   * behind our back is not silently re-created in a folder that may be gone.
   */
  async write(absolutePath: string, content: string): Promise<number> {
    this.assertAllowed(absolutePath, 'written');
    if (Buffer.byteLength(content, 'utf-8') > this.maxBytes) {
      throw new Error(
        `File is larger than ${Math.round(this.maxBytes / (1024 * 1024))} MB and cannot be saved.`,
      );
    }
    const existing = await fsp.stat(absolutePath).catch(() => null);
    if (existing === null || !existing.isFile()) {
      throw new Error('The file no longer exists at its original location. Use Save as… to keep a copy.');
    }
    await fsp.writeFile(absolutePath, content, 'utf-8');
    return (await fsp.stat(absolutePath)).mtimeMs;
  }

  private classifyAll(absolutePaths: readonly string[]): OpenRequest[] {
    const vaults = this.getVaults();
    const seen = new Set<string>();
    const out: OpenRequest[] = [];
    for (const absolute of absolutePaths) {
      const located = locateInVaults(vaults, absolute);
      const request: OpenRequest =
        located !== null
          ? { kind: 'vault', vaultId: located.vaultId, path: located.path }
          : { kind: 'external', path: canonical(absolute) };
      const identity =
        request.kind === 'vault' ? `${request.vaultId}::${request.path}` : allowKey(request.path);
      if (seen.has(identity)) {
        continue;
      }
      seen.add(identity);
      if (request.kind === 'external') {
        this.allowed.add(allowKey(request.path));
      }
      out.push(request);
    }
    return out;
  }
}
