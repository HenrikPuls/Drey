/**
 * The fleet runner's build stamp (req-51): which code a runner serves.
 *
 * The stamp used to be the mtime of `runner.js`, and every dev rebuild
 * rewrites that file (tsc emits everything), so the plugin retired a
 * runner — and with it every live worker — on each restart of Drey even
 * when not a line of fleet code had changed. The stamp is now a content
 * hash over the runner entry and every module it requires from the
 * build (its relative `require` closure: `fleet/`, the ticket-file
 * helpers, the repo's `shared/`), plus the newest mtime among them:
 *
 * - equal hashes: the same code, whatever the mtimes — the runner stays;
 * - different hashes: the newer build wins (`builtAt`), so two Drey
 *   checkouts sharing one fleet root never retire each other in a loop.
 *
 * Format: `<builtAt ISO>#<hash>`. A stamp without `#` is a pre-req-51
 * daemon's plain mtime; it compares by date only.
 */
import * as crypto from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

/** A relative `require("./x")` / `require("../x")` as tsc emits it. */
const RELATIVE_REQUIRE = /\brequire\("(\.{1,2}\/[^"]+)"\)/g;

export interface ParsedStamp {
  readonly builtAt: string;
  /** Null for a pre-req-51 stamp (mtime only). */
  readonly hash: string | null;
}

export function parseStamp(stamp: string): ParsedStamp {
  const cut = stamp.indexOf('#');
  return cut < 0 ? { builtAt: stamp, hash: null } : { builtAt: stamp.slice(0, cut), hash: stamp.slice(cut + 1) };
}

export function formatStamp(builtAt: string, hash: string): string {
  return `${builtAt}#${hash}`;
}

/**
 * The retirement decision's ordered core: retire only a daemon whose
 * build is OLDER than the client's own. Two Drey checkouts share one
 * fleet root, so an inequality would have the instances retire each
 * other's runner in an endless loop — the newest build's daemon serves
 * both, and only a genuinely outdated one is replaced.
 */
export function isOlderBuild(daemonBuild: string, clientBuild: string): boolean {
  const daemon = Date.parse(parseStamp(daemonBuild).builtAt);
  const client = Date.parse(parseStamp(clientBuild).builtAt);
  return Number.isFinite(daemon) && Number.isFinite(client) && daemon < client;
}

/**
 * Stale = the daemon runs other code than this build and is older. The
 * same code hash is never stale, however much newer the files on disk
 * are. A daemon that reports no stamp predates the stamp itself, so it
 * is older than every build that can ask.
 */
export function isStaleDaemon(daemonBuild: string | undefined, clientBuild: string | null): boolean {
  if (clientBuild === null) {
    return false;
  }
  if (daemonBuild === undefined) {
    return true;
  }
  const daemonHash = parseStamp(daemonBuild).hash;
  if (daemonHash !== null && daemonHash === parseStamp(clientBuild).hash) {
    return false;
  }
  return isOlderBuild(daemonBuild, clientBuild);
}

/** The entry plus every built module it reaches through relative requires. */
export async function requireClosure(entry: string): Promise<readonly string[]> {
  const seen = new Set<string>();
  const queue = [path.resolve(entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) {
      continue;
    }
    const text = await fsp.readFile(file, 'utf8').catch(() => null);
    if (text === null) {
      continue;
    }
    seen.add(file);
    for (const match of text.matchAll(RELATIVE_REQUIRE)) {
      const resolved = await resolveModule(path.resolve(path.dirname(file), match[1]!));
      if (resolved !== null && !seen.has(resolved)) {
        queue.push(resolved);
      }
    }
  }
  return [...seen].sort();
}

async function resolveModule(base: string): Promise<string | null> {
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    const stat = await fsp.stat(candidate).catch(() => null);
    if (stat?.isFile() === true) {
      return candidate;
    }
  }
  return null;
}

/**
 * The stamp of the build `entry` belongs to. The hash covers each
 * module's path relative to the entry's folder and its bytes, so two
 * checkouts with the same code agree.
 */
export async function fleetBuildStamp(entry: string): Promise<string> {
  const files = await requireClosure(entry);
  const hash = crypto.createHash('sha256');
  let newest = 0;
  const root = path.dirname(path.resolve(entry));
  for (const file of files) {
    const [bytes, stat] = await Promise.all([fsp.readFile(file), fsp.stat(file)]);
    hash.update(path.relative(root, file).split(path.sep).join('/'));
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
    newest = Math.max(newest, stat.mtimeMs);
  }
  return formatStamp(new Date(newest).toISOString(), hash.digest('hex').slice(0, 16));
}
