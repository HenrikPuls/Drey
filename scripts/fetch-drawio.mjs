/**
 * Fetches the draw.io web app the diagrams plugin embeds (ADR-0064).
 *
 * The editor is not an npm package and is far too large for git (about
 * 3000 files), so it is downloaded as the pinned release archive
 * (`draw.war`, an ordinary zip), checked against its SHA-256 and unpacked
 * into `plugins/drawio/vendor/webapp/` (gitignored). `build-plugins.mjs`
 * copies that folder next to the built plugin.
 *
 * Idempotent: a `vendor/webapp/.version` stamp matching the pin skips the
 * download. The pin lives in `plugins/drawio/drawio-version.json` (also
 * read by the licence list): to update draw.io, change `version` and
 * `sha256` together (the release page lists the digest) and re-check the
 * embed protocol against `plugins/drawio/renderer/embed-session.ts`.
 *
 * The Apache 2.0 licence text is fetched alongside and ships as
 * `webapp/LICENSE`.
 *
 * Only what the offline embed mode loads is kept: server classes, the
 * service worker, cloud storage connectors, the stand-alone viewer builds
 * and the unminified development sources are left out.
 *
 * No dependencies: a small central-directory zip reader over node:zlib.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';


/** Path prefixes (folders end in `/`) and exact names left out of the copy. */
const EXCLUDED_PREFIXES = [
  'META-INF/',
  'WEB-INF/',
  'connect/',
  'js/diagramly/',
  'js/grapheditor/',
  'js/dropbox/',
  'js/onedrive/',
  'mxgraph/src/',
];
const EXCLUDED_FILES = new Set([
  'service-worker.js',
  'js/integrate.min.js',
  'js/viewer.min.js',
  'js/viewer-static.min.js',
  'js/embed.dev.js',
  'mxgraph/mxClient.js',
  'dropbox.html',
  'github.html',
  'gitlab.html',
  'onedrive3.html',
  'teams.html',
  'monday-app-association.json',
]);

function isExcluded(name) {
  return (
    EXCLUDED_FILES.has(name) ||
    name.endsWith('.map') ||
    name.startsWith('workbox-') ||
    EXCLUDED_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/** Yields `{ name, data }` for every file entry of a (non-zip64) archive. */
function* zipEntries(buffer) {
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pin = JSON.parse(
  readFileSync(path.join(repoRoot, 'plugins', 'drawio', 'drawio-version.json'), 'utf8'),
);
const VERSION = pin.version;
const SHA256 = pin.sha256;
const URL = `https://github.com/jgraph/drawio/releases/download/v${VERSION}/draw.war`;
const LICENSE_URL = `https://raw.githubusercontent.com/jgraph/drawio/v${VERSION}/LICENSE`;
const target = path.join(repoRoot, 'plugins', 'drawio', 'vendor', 'webapp');
const stamp = path.join(target, '.version');

if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === VERSION) {
  console.log(`draw.io ${VERSION} already present.`);
  process.exit(0);
}

console.log(`Downloading draw.io ${VERSION} …`);
const response = await fetch(URL);
if (!response.ok) {
  throw new Error(`download failed: ${response.status} ${response.statusText} (${URL})`);
}
const archive = Buffer.from(await response.arrayBuffer());
const digest = createHash('sha256').update(archive).digest('hex');
if (digest !== SHA256) {
  throw new Error(`checksum mismatch for draw.war: expected ${SHA256}, got ${digest}`);
}

rmSync(target, { recursive: true, force: true });
let kept = 0;
let bytes = 0;
for (const entry of zipEntries(archive)) {
  if (isExcluded(entry.name)) {
    continue;
  }
  const file = path.join(target, entry.name);
  // A zip entry must never write outside the target folder.
  if (path.relative(target, file).startsWith('..')) {
    throw new Error(`refusing zip entry outside the target: ${entry.name}`);
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, entry.data);
  kept++;
  bytes += entry.data.length;
}
const license = await fetch(LICENSE_URL);
if (!license.ok) {
  throw new Error(`licence download failed: ${license.status} (${LICENSE_URL})`);
}
writeFileSync(path.join(target, 'LICENSE'), await license.text());
writeFileSync(stamp, `${VERSION}\n`);
console.log(`draw.io ${VERSION}: ${kept} files, ${(bytes / 1024 / 1024).toFixed(1)} MB -> ${path.relative(repoRoot, target)}`);
