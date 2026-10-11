import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_API_VERSION } from '../../shared/plugin-api';
import { PluginInstaller } from './plugin-installer';

vi.mock('electron', () => ({
  dialog: {},
  shell: {},
  BrowserWindow: { getAllWindows: () => [] },
}));

let tmp = '';
let userRoot = '';
let log: string[] = [];

const MANIFEST = {
  id: 'packed',
  name: 'Packed plugin',
  version: '1.0.0',
  apiVersion: PLUGIN_API_VERSION.major,
  description: 'Written by plugin-installer.spec.ts',
  main: 'main/index.js',
  renderer: 'renderer/index.js',
  permissions: ['documents'],
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = ~0;
  for (const byte of data) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return ~c >>> 0;
}

/** Minimal store-only zip (local headers + central directory + EOCD). */
function writeZip(files: Record<string, string | Buffer>): string {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const count = Object.keys(files).length;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0, 8); // flags
    entry.writeUInt16LE(0, 10); // method: stored
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const zipPath = path.join(tmp, 'plugin-package.zip');
  fs.writeFileSync(zipPath, Buffer.concat([...parts, cd, eocd]));
  return zipPath;
}

function installer(): PluginInstaller {
  return new PluginInstaller({
    userRoot,
    pluginHost: { pluginById: () => undefined } as never,
    log: (message) => log.push(message),
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-plugin-install-'));
  userRoot = path.join(tmp, 'plugins');
  log = [];
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('PluginInstaller.install', () => {
  it('installs a package and strips Node module-type markers next to the code', async () => {
    const zipPath = writeZip({
      'plugin.json': JSON.stringify(MANIFEST),
      'main/index.js': 'module.exports = { activate() {} };',
      'renderer/index.js': 'const mod = { activate() {} }; export default mod;',
      'package.json': '{"type":"module"}',
      'main/package.json': '{"type":"commonjs"}',
      // Compress-Archive writes backslash entry names; same marker, dropped too.
      'main\\package.json': '{"type":"module"}',
    });

    const result = await installer().install(zipPath);

    expect(result).toMatchObject({ status: 'installed', pluginId: 'packed', upgraded: false });
    const target = path.join(userRoot, 'packed');
    expect(fs.readFileSync(path.join(target, 'plugin.json'), 'utf8')).toContain('"packed"');
    expect(fs.existsSync(path.join(target, 'package.json'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'main', 'package.json'))).toBe(false);
    // The payload itself is all there.
    expect(fs.existsSync(path.join(target, 'main', 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'renderer', 'index.js'))).toBe(true);
    expect(log.join('\n')).toContain('"packed" v1.0.0 installed');
  });

  it('leaves a deeper package.json (bundled third-party content) untouched', async () => {
    const zipPath = writeZip({
      'plugin.json': JSON.stringify(MANIFEST),
      'main/index.js': 'module.exports = { activate() {} };',
      'renderer/index.js': 'const mod = { activate() {} }; export default mod;',
      'vendor/webapp/package.json': '{"type":"module"}',
    });

    const result = await installer().install(zipPath);

    expect(result).toMatchObject({ status: 'installed' });
    expect(
      fs.readFileSync(path.join(userRoot, 'packed', 'vendor', 'webapp', 'package.json'), 'utf8'),
    ).toBe('{"type":"module"}');
  });
});
