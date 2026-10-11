import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLUGIN_API_VERSION } from '../../shared/plugin-api';
import { discoverPlugins, isSafeEntryPath, type DiscoveredPlugin } from './plugin-discovery';

let tmp = '';
let builtinRoot = '';
let userRoot = '';
let extraRoot = '';
let log: string[] = [];

/** Writes `<root>/<folder>/plugin.json`; a string is written as it is. */
function plugin(root: string, folder: string, manifest: Record<string, unknown> | string = {}): void {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  const content =
    typeof manifest === 'string'
      ? manifest
      : JSON.stringify({
          id: folder,
          name: `Plugin ${folder}`,
          version: '1.0.0',
          apiVersion: PLUGIN_API_VERSION.major,
          ...manifest,
        });
  fs.writeFileSync(path.join(dir, 'plugin.json'), content);
}

function discover(disabled: string[] = [], extra: string | null = extraRoot): Promise<DiscoveredPlugin[]> {
  return discoverPlugins({
    builtinRoot,
    userRoot,
    extraRoot: extra,
    pluginsConfig: { disabled },
    log: (message) => log.push(message),
  });
}

const summary = (plugins: DiscoveredPlugin[]): string[] =>
  plugins.map((p) => `${p.manifest.id}:${p.status}:${p.builtin ? 'builtin' : 'user'}`);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-plugins-'));
  builtinRoot = path.join(tmp, 'builtin');
  userRoot = path.join(tmp, 'user');
  extraRoot = path.join(tmp, 'extra');
  log = [];
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('isSafeEntryPath', () => {
  it('accepts relative paths inside the plugin folder', () => {
    for (const ok of ['main/index.js', 'renderer/index.js', 'a.css', 'renderer\\style.css']) {
      expect(isSafeEntryPath(ok)).toBe(true);
    }
  });

  it('refuses everything that could leave it', () => {
    for (const bad of ['', '/etc/passwd', '\\\\server\\share\\x.js', 'C:\\x.js', 'c:/x.js', '../x.js', 'a/../../x.js', './x.js', 'a//b.js', 'a/']) {
      expect(isSafeEntryPath(bad)).toBe(false);
    }
  });
});

describe('discoverPlugins', () => {
  it('finds nothing, and complains about nothing, when no root exists', async () => {
    await expect(discover()).resolves.toEqual([]);
    expect(log).toEqual([]);
  });

  it('finds plugins in every root, built-ins first, each root in name order', async () => {
    plugin(builtinRoot, 'tasks', { main: 'main/index.js', renderer: 'renderer/index.js', css: ['renderer/style.css'] });
    plugin(builtinRoot, 'assistant');
    plugin(userRoot, 'mine');
    plugin(extraRoot, 'fixture');
    fs.mkdirSync(path.join(userRoot, 'not-a-plugin'));
    fs.writeFileSync(path.join(userRoot, 'stray-file.txt'), '');

    const found = await discover();

    expect(summary(found)).toEqual([
      'assistant:active:builtin',
      'tasks:active:builtin',
      'mine:active:user',
      'fixture:active:user',
    ]);
    expect(found[1].rootDir).toBe(path.join(builtinRoot, 'tasks'));
    expect(found[1].manifest.main).toBe('main/index.js');
    expect(log).toEqual([]);
  });

  it('does not look at the extra root unless one is given', async () => {
    plugin(extraRoot, 'fixture');
    await expect(discover([], null)).resolves.toEqual([]);
    await expect(discover([], '')).resolves.toEqual([]);
  });

  it('lets a built-in win over a user plugin of the same id', async () => {
    plugin(builtinRoot, 'tags', { version: '2.0.0' });
    plugin(userRoot, 'tags', { version: '9.9.9' });

    const found = await discover();

    expect(summary(found)).toEqual(['tags:active:builtin']);
    expect(found[0].manifest.version).toBe('2.0.0');
    expect(log).toHaveLength(1);
    expect(log[0]).toContain('duplicate id "tags"');
  });

  it('keeps a switched-off plugin in the list, marked disabled', async () => {
    plugin(builtinRoot, 'git');
    plugin(builtinRoot, 'tags');

    expect(summary(await discover(['git', 'unknown-id']))).toEqual(['git:disabled:builtin', 'tags:active:builtin']);
  });

  it('marks a plugin built for another API version, with the reason', async () => {
    plugin(userRoot, 'old', { apiVersion: PLUGIN_API_VERSION.major + 1 });

    const [found] = await discover();

    expect(found.status).toBe('incompatible');
    expect(found.error).toContain(`does not match app api version ${PLUGIN_API_VERSION.major}`);
    // Switched off wins: nothing to report about a plugin that is not loaded anyway.
    expect((await discover(['old']))[0].status).toBe('disabled');
  });

  it('skips and logs what it cannot use, without throwing', async () => {
    plugin(userRoot, 'broken-json', '{ not json');
    plugin(userRoot, 'no-name', { name: '' });
    plugin(userRoot, 'folder-name', { id: 'other-id' });
    plugin(userRoot, 'escapes-main', { main: '../../outside.js' });
    plugin(userRoot, 'escapes-css', { css: ['ok.css', 'C:\\Windows\\x.css'] });
    plugin(userRoot, 'escapes-renderer', { renderer: '/abs/index.js' });
    plugin(userRoot, 'good');

    const found = await discover();

    expect(summary(found)).toEqual(['good:active:user']);
    expect(log).toHaveLength(6);
    expect(log.join('\n')).toContain('is not valid JSON');
    expect(log.join('\n')).toContain('does not match folder name "folder-name"');
    expect(log.join('\n')).toContain('unsafe entry path "../../outside.js"');
    expect(log.join('\n')).toContain('unsafe renderer path "/abs/index.js"');
  });
});
