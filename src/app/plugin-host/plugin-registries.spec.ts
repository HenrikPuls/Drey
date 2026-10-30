import { TestBed } from '@angular/core/testing';
import { DocKindRegistry } from './doc-kind-registry.service';
import { EditorExtensionRegistry } from './editor-extension-registry.service';
import { DropDecoderRegistry } from './drop-decoder-registry.service';
import {
  EditorContextMenuRegistry,
  MenuContributionsService,
} from './menu-contributions.service';
import { HOST_CODEMIRROR } from './runtime-exports';

describe('EditorExtensionRegistry', () => {
  let registry: EditorExtensionRegistry;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    registry = TestBed.inject(EditorExtensionRegistry);
  });

  it('evaluates matching factories per surface, document and composer slots', () => {
    const calls: string[] = [];
    registry.register('p', 'document', () => calls.push('doc'));
    registry.register('p', 'composer', () => calls.push('composer'));
    registry.register('p', 'both', () => calls.push('both'));

    const ctx = { slot: 'document' as const, path: () => null, filename: () => null, vaultId: () => null };
    registry.extensionsFor('document', ctx);
    expect(calls).toEqual(['doc', 'both']);

    calls.length = 0;
    registry.extensionsFor('composer', ctx);
    expect(calls).toEqual(['composer', 'both']);
  });

  it('skips a throwing factory and keeps the rest', () => {
    registry.register('bad', 'document', () => {
      throw new Error('boom');
    });
    registry.register('good', 'document', () => 'ext');
    const out = registry.extensionsFor('document', {
      slot: 'document',
      path: () => null,
      filename: () => null,
      vaultId: () => null,
    });
    expect(out).toEqual(['ext']);
  });

  it('bumps the revision on register and unregister so surfaces reconfigure', () => {
    const seen: number[] = [];
    const unsubscribe = registry.register('p', 'both', () => []);
    seen.push(registry.revision());
    registry.register('p', 'both', () => []);
    seen.push(registry.revision());
    unsubscribe();
    expect(seen[0]).toBeLessThan(seen[1]);
    expect(registry.revision()).toBe(seen[1] + 1);
  });
});

describe('DropDecoderRegistry', () => {
  let registry: DropDecoderRegistry;

  const dropWith = (types: string[]): DataTransfer =>
    ({ types }) as unknown as DataTransfer;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    registry = TestBed.inject(DropDecoderRegistry);
  });

  it('runs the first claiming decoder and skips unclaimed drops', async () => {
    const order: string[] = [];
    const unsubA = registry.register({
      match: (data) => data.types.includes('a'),
      decode: async () => {
        order.push('a');
        return 'A';
      },
    });
    registry.register({
      match: (data) => data.types.includes('a'),
      decode: async () => {
        order.push('b');
        return 'B';
      },
    });

    expect(registry.claims(dropWith(['a']))).toBe(true);
    expect(await registry.decode(dropWith(['a']))).toBe('A');
    expect(order).toEqual(['a']); // first match wins

    unsubA();
    expect(await registry.decode(dropWith(['a']))).toBe('B');
    expect(await registry.decode(dropWith(['none']))).toBeNull();
    expect(registry.claims(dropWith(['none']))).toBe(false);
  });

  it('treats a throwing match() as unclaimed', () => {
    registry.register({
      match: () => {
        throw new Error('nope');
      },
      decode: async () => 'never',
    });
    expect(registry.claims(dropWith(['x']))).toBe(false);
  });
});

describe('MenuContributionsService + EditorContextMenuRegistry', () => {
  it('routes contributions to their menu and removes them on unsubscribe', () => {
    TestBed.configureTestingModule({});
    const service = TestBed.inject(MenuContributionsService);
    const unsubscribe = service.register('p', [
      { menu: 'file', label: 'File row', run: () => undefined },
      { menu: 'view', label: 'View row', run: () => undefined },
    ]);

    expect(service.itemsFor('file').map((i) => i.label)).toEqual(['File row']);
    expect(service.itemsFor('edit')).toEqual([]);
    unsubscribe();
    expect(service.itemsFor('file')).toEqual([]);
  });

  it('evaluates context-menu providers per open and forwards the click target', () => {
    TestBed.configureTestingModule({});
    const registry = TestBed.inject(EditorContextMenuRegistry);
    type MenuTarget = import('../../../shared/plugin-api/renderer').EditorContextMenuTarget;
    const imageTarget: MenuTarget = { surface: 'image', imagePath: 'a.png' };
    const editorTarget: MenuTarget = {
      surface: 'editor',
      docPath: 'n.md',
      target: document.createElement('div'),
      lineNumber: 2,
      lineText: '![x](a.png)',
    };
    let enabled = false;
    registry.register((target) =>
      enabled && target.surface === 'image'
        ? [{ label: 'Recognize text', run: () => undefined }]
        : [],
    );

    expect(registry.items(imageTarget)).toEqual([]);
    enabled = true;
    expect(registry.items(imageTarget).map((i) => i.label)).toEqual(['Recognize text']);
    // The target reaches the provider — an editor click gets no image-surface row.
    expect(registry.items(editorTarget)).toEqual([]);
  });

  it('skips a throwing context-menu provider and keeps the rest', () => {
    TestBed.configureTestingModule({});
    const registry = TestBed.inject(EditorContextMenuRegistry);
    const target: import('../../../shared/plugin-api/renderer').EditorContextMenuTarget = {
      surface: 'image',
      imagePath: 'a.png',
    };
    registry.register(() => {
      throw new Error('boom');
    });
    registry.register(() => [{ label: 'ok', run: () => undefined }]);

    expect(registry.items(target).map((i) => i.label)).toEqual(['ok']);
  });

  it('orders base (head) rows before plugin (tail) rows regardless of registration order (req-34)', () => {
    TestBed.configureTestingModule({});
    const registry = TestBed.inject(EditorContextMenuRegistry);
    const target: import('../../../shared/plugin-api/renderer').EditorContextMenuTarget = {
      surface: 'editor',
      docPath: 'n.md',
      target: document.createElement('div'),
      lineNumber: null,
      lineText: null,
    };
    // The plugin registers FIRST (activation runs before App's bootstrap),
    // the base row SECOND — the head flag must still keep the base row on
    // top, and the groups come back separately for the separator.
    registry.register(() => [{ label: 'Recent template', run: () => undefined }]);
    registry.register(() => [{ label: 'Export as PDF…', run: () => undefined }], { head: true });

    expect(registry.items(target).map((i) => i.label)).toEqual(['Export as PDF…', 'Recent template']);
    const grouped = registry.groupedItems(target);
    expect(grouped.head.map((i) => i.label)).toEqual(['Export as PDF…']);
    expect(grouped.tail.map((i) => i.label)).toEqual(['Recent template']);
  });
});

describe('DocKindRegistry', () => {
  let registry: DocKindRegistry;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    registry = TestBed.inject(DocKindRegistry);
  });

  const kind = (name: string): import('../../../shared/plugin-api/renderer').PluginDocKindContrib => ({
    kind: name,
    serialize: () => null,
    restore: () => undefined,
    mount: () => () => undefined,
  });

  it('registers and unregisters kinds; a later duplicate replaces the first', () => {
    const first = kind('browser');
    const unsub = registry.register(first);
    expect(registry.get('browser')).toBe(first);

    const second = kind('browser');
    registry.register(second);
    expect(registry.get('browser')).toBe(second); // later wins, warned

    unsub();
    expect(registry.get('browser')).toBe(second); // only the owner's own unsubscribe removes
  });

  it('answers favicon/statusText and guards a throwing callback', () => {
    registry.register({
      ...kind('bad'),
      favicon: () => {
        throw new Error('boom');
      },
      statusText: () => null,
    });
    registry.register({
      ...kind('good'),
      icon: 'globe',
      favicon: () => 'f.ico',
      statusText: () => 'url text',
    });

    expect(registry.faviconFor('good', 'k://1')).toBe('f.ico');
    expect(registry.statusTextFor('good', 'k://1')).toBe('url text');
    expect(registry.faviconFor('bad', 'k://1')).toBeNull(); // throw -> logged, null
    expect(registry.faviconFor('plain', 'k://1')).toBeNull(); // no slot at all
    expect(registry.statusTextFor('plain', 'k://1')).toBeNull();
  });
});

describe('HOST_CODEMIRROR', () => {
  it('exposes the same module instances the editor bundle uses', () => {
    // The identity guarantee of ADR-0044 rule 1: `EditorState` here must BE
    // the one the surface's compartments come from.
    expect(HOST_CODEMIRROR.state.EditorState).toBeDefined();
    expect(HOST_CODEMIRROR.view.EditorView).toBeDefined();
    expect(HOST_CODEMIRROR.langMarkdown.markdownLanguage).toBeDefined();
  });
});
