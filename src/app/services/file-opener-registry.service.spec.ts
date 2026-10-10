import { TestBed } from '@angular/core/testing';
import { DreyApi } from '../../../shared/ipc-api';
import { refreshChangedAssets, resolveVaultImageUrl } from '../editor/vault-image';
import { ToolbarContributionsService } from '../plugin-host';
import { EditorService } from './editor.service';
import { FileOpenerRegistry } from './file-opener-registry.service';

describe('FileOpenerRegistry (SDK 1.16, ADR-0064)', () => {
  let registry: FileOpenerRegistry;

  beforeEach(() => {
    registry = TestBed.inject(FileOpenerRegistry);
  });

  it('claims files by name suffix, case-insensitively', () => {
    const opened: [string, string | null][] = [];
    registry.register({
      extensions: ['.drawio'],
      open: (path, vaultId) => opened.push([path, vaultId]),
    });
    expect(registry.open('plans/Site.DRAWIO', 'v1')).toBe(true);
    expect(registry.open('plans/site.md', 'v1')).toBe(false);
    expect(opened).toEqual([['plans/Site.DRAWIO', 'v1']]);
  });

  it('lets the longest suffix win', () => {
    const svg = { extensions: ['.svg'], open: vi.fn() };
    const diagram = { extensions: ['.drawio.svg', '.drawio'], open: vi.fn() };
    registry.register(svg);
    registry.register(diagram);
    expect(registry.find('a.drawio.svg')).toBe(diagram);
    expect(registry.find('a.svg')).toBe(svg);
  });

  it('ignores a suffix without a leading dot', () => {
    registry.register({ extensions: ['drawio'], open: vi.fn() });
    expect(registry.find('a.drawio')).toBeNull();
  });

  it('forgets an opener when unsubscribed', () => {
    const off = registry.register({ extensions: ['.drawio'], open: vi.fn() });
    off();
    expect(registry.find('a.drawio')).toBeNull();
  });

  it('falls back to the base routing when the opener throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    registry.register({
      extensions: ['.drawio'],
      open: () => {
        throw new Error('kind not registered');
      },
    });
    expect(registry.open('a.drawio', null)).toBe(false);
  });
});

describe('EditorService.openFile with a plugin file opener', () => {
  let service: EditorService;
  let registry: FileOpenerRegistry;
  let reads: string[];

  beforeEach(() => {
    reads = [];
    const fakeApi: Partial<DreyApi> = {
      readVaultFile: (relativePath: string) => {
        reads.push(relativePath);
        return Promise.resolve({ content: 'text', modifiedMs: 1 });
      },
    };
    window.dreyApi = fakeApi as DreyApi;
    service = TestBed.inject(EditorService);
    registry = TestBed.inject(FileOpenerRegistry);
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
    localStorage.removeItem('drey.editor');
  });

  it('hands a claimed file to the plugin instead of opening an image tab', async () => {
    registry.register({
      extensions: ['.drawio.svg'],
      open: (path) => service.addPluginDoc('drawio', `drawio:///${path}`, 'd.drawio.svg'),
    });
    await service.openFile('att/d.drawio.svg');
    expect(service.openDocs().map((d) => [d.kind, d.path])).toEqual([
      ['drawio', 'drawio:///att/d.drawio.svg'],
    ]);
    expect(reads).toEqual([]);
  });

  it('replaces the clean tab it was opened over, like any other open', async () => {
    registry.register({
      extensions: ['.drawio'],
      open: (path) => service.addPluginDoc('drawio', `drawio:///${path}`, path),
    });
    await service.openFile('note.md');
    await service.openFile('plan.drawio');
    expect(service.openDocs().map((d) => d.path)).toEqual(['drawio:///plan.drawio']);
  });

  it('opens the file as before when no plugin claims it', async () => {
    await service.openFile('att/d.drawio.svg');
    expect(service.openDocs().map((d) => d.kind)).toEqual(['image']);
    await service.openFile('plan.drawio');
    expect(reads).toEqual(['plan.drawio']);
  });
});

describe('ToolbarContributionsService (SDK 1.16)', () => {
  it('lists contributed buttons in registration order and forgets them on unsubscribe', () => {
    const toolbar = TestBed.inject(ToolbarContributionsService);
    const first = [{ icon: 'shapes', title: 'Insert diagram', run: vi.fn() }];
    const second = [{ icon: 'code', title: 'Other', commandId: 'x.y' }];
    const offFirst = toolbar.register(first);
    toolbar.register(second);
    expect(toolbar.buttons().map((b) => b.title)).toEqual(['Insert diagram', 'Other']);
    offFirst();
    expect(toolbar.buttons().map((b) => b.title)).toEqual(['Other']);
  });
});

describe('refreshChangedAssets (milestone 64)', () => {
  it('gives a changed picture a new URL, on screen and for later renders', () => {
    const root = document.createElement('div');
    const changed = document.createElement('img');
    changed.setAttribute('src', 'drey-asset://v1/asset/att/rev-test.drawio.svg');
    const other = document.createElement('img');
    other.setAttribute('src', 'drey-asset://v1/asset/att/other.png');
    const foreignVault = document.createElement('img');
    foreignVault.setAttribute('src', 'drey-asset://v2/asset/att/rev-test.drawio.svg');
    root.append(changed, other, foreignVault);

    refreshChangedAssets('v1', ['att/rev-test.drawio.svg'], root);
    expect(changed.getAttribute('src')).toBe('drey-asset://v1/asset/att/rev-test.drawio.svg?v=1');
    expect(other.getAttribute('src')).toBe('drey-asset://v1/asset/att/other.png');
    expect(foreignVault.getAttribute('src')).toBe('drey-asset://v2/asset/att/rev-test.drawio.svg');
    expect(resolveVaultImageUrl('att/note.md', 'rev-test.drawio.svg', 'v1')).toBe(
      'drey-asset://v1/asset/att/rev-test.drawio.svg?v=1',
    );

    refreshChangedAssets('v1', ['att/rev-test.drawio.svg'], root);
    expect(changed.getAttribute('src')).toBe('drey-asset://v1/asset/att/rev-test.drawio.svg?v=2');
  });
});
