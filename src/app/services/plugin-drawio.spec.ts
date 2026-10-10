import {
  DIAGRAM_SUFFIXES,
  EMPTY_DIAGRAM_XML,
  PLACEHOLDER,
  diagramCandidatesInLine,
  diagramFormatOf,
  diagramFromAssetUrl,
  diagramXmlOf,
  docKeyFor,
  emptyDiagram,
  emptyDiagramPng,
  emptyDiagramSvg,
  isPictureDiagram,
  newDiagramTarget,
  parseDocKey,
  pictureFormat,
  pictureWithDiagram,
  placeholderDiagramPng,
  pngDiagramXml,
} from '../../../plugins/drawio/renderer/diagram-file';
import {
  EmbedSession,
  editorFrameUrl,
  type EmbedSessionOptions,
} from '../../../plugins/drawio/renderer/embed-session';
import { inFrontmatter, matchesDiagram } from '../../../plugins/drawio/renderer/slash';

const BOX_XML = '<mxfile><diagram name="Ä &amp; B"><mxGraphModel/></diagram></mxfile>';

describe('drawio plugin: diagram files (ADR-0064)', () => {
  it('recognises the three formats by suffix, case-insensitively', () => {
    expect(diagramFormatOf('a/b.drawio.svg')).toBe('svg');
    expect(diagramFormatOf('a/B.DRAWIO.PNG')).toBe('png');
    expect(diagramFormatOf('plan.drawio')).toBe('xml');
    expect(diagramFormatOf('photo.png')).toBeNull();
    expect(diagramFormatOf('notes.md')).toBeNull();
    expect(isPictureDiagram('x.drawio.svg')).toBe(true);
    expect(isPictureDiagram('x.drawio.png')).toBe(true);
    expect(isPictureDiagram('x.drawio')).toBe(false);
    expect(DIAGRAM_SUFFIXES).toEqual(['.drawio.svg', '.drawio.png', '.drawio']);
  });

  it('round-trips a tab key, with and without a vault', () => {
    const withVault = { vaultId: 'v1', path: 'docs/a b.drawio.svg' };
    expect(parseDocKey(docKeyFor(withVault))).toEqual(withVault);
    const active = { vaultId: null, path: 'x.drawio' };
    expect(docKeyFor(active)).toBe('drawio:///x.drawio');
    expect(parseDocKey(docKeyFor(active))).toEqual(active);
    expect(parseDocKey('notes/x.md')).toBeNull();
    expect(parseDocKey('drawio://v1/')).toBeNull();
  });

  it('finds the diagram behind an embedded picture URL', () => {
    expect(diagramFromAssetUrl('drey-asset://v1/asset/att/my%20d.drawio.svg?v=3')).toEqual({
      vaultId: 'v1',
      path: 'att/my d.drawio.svg',
    });
    expect(diagramFromAssetUrl('drey-asset://v1/asset/att/d.drawio.png')).toEqual({
      vaultId: 'v1',
      path: 'att/d.drawio.png',
    });
    expect(diagramFromAssetUrl('drey-asset://asset/d.drawio.svg')).toEqual({
      vaultId: null,
      path: 'd.drawio.svg',
    });
    expect(diagramFromAssetUrl('drey-asset://v1/asset/photo.png')).toBeNull();
    expect(diagramFromAssetUrl('https://example.com/d.drawio.svg')).toBeNull();
  });

  it('places a new diagram in attachments/ beside the note, in the chosen format', () => {
    const now = new Date(2026, 9, 10, 20, 30, 5);
    expect(newDiagramTarget('projects/plan.md', now, 'svg')).toEqual({
      path: 'projects/attachments/diagram-20261010-203005.drawio.svg',
      reference: 'attachments/diagram-20261010-203005.drawio.svg',
    });
    expect(newDiagramTarget('plan.md', now, 'png').path).toBe(
      'attachments/diagram-20261010-203005.drawio.png',
    );
    expect(newDiagramTarget(null, now, 'png').path).toBe(
      'attachments/diagram-20261010-203005.drawio.png',
    );
  });

  it('falls back to SVG for an unknown stored format', () => {
    expect(pictureFormat('png')).toBe('png');
    expect(pictureFormat('svg')).toBe('svg');
    expect(pictureFormat(undefined)).toBe('svg');
    expect(pictureFormat('gif')).toBe('svg');
  });

  it('creates blank files the loader reads back as the empty diagram', async () => {
    expect(diagramXmlOf('svg', emptyDiagramSvg())).toBe(EMPTY_DIAGRAM_XML);
    expect(diagramXmlOf('png', await emptyDiagramPng())).toBe(EMPTY_DIAGRAM_XML);
    expect(diagramXmlOf('xml', (await emptyDiagram('xml')) as string)).toContain('<mxfile>');
    expect(await emptyDiagram('png')).toBeInstanceOf(Uint8Array);
  });

  it('makes a blank SVG a visible placeholder, not a pixel', () => {
    const root = new DOMParser().parseFromString(emptyDiagramSvg(), 'image/svg+xml').documentElement;
    expect(root.getAttribute('width')).toBe(`${PLACEHOLDER.width}px`);
    expect(root.getAttribute('height')).toBe(`${PLACEHOLDER.height}px`);
    expect(root.querySelector('rect')).not.toBeNull();
    expect(root.querySelector('text')?.textContent).toBe('Empty diagram');
  });

  it('finds the diagram a Markdown line embeds, note-relative before vault-root', () => {
    expect(diagramCandidatesInLine('![diagram](attachments/d.drawio.svg)', 'projects/plan.md')).toEqual([
      'projects/attachments/d.drawio.svg',
      'attachments/d.drawio.svg',
    ]);
    expect(diagramCandidatesInLine('text ![x|300](<../img/my d.drawio.png>) more', 'a/b/n.md')).toEqual([
      'a/img/my d.drawio.png',
    ]);
    expect(diagramCandidatesInLine('![d](d.drawio.svg)', 'n.md')).toEqual(['d.drawio.svg']);
    expect(diagramCandidatesInLine('![d](a%20b.drawio.svg)', 'n.md')).toEqual(['a b.drawio.svg']);
    expect(diagramCandidatesInLine('![p](photo.png)', 'n.md')).toEqual([]);
    expect(diagramCandidatesInLine('![d](https://x.test/d.drawio.svg)', 'n.md')).toEqual([]);
    expect(diagramCandidatesInLine('no embed here', 'n.md')).toEqual([]);
  });

  it('offers the slash entry for a prefix of "diagram" and stays out of frontmatter', () => {
    expect(matchesDiagram('')).toBe(true);
    expect(matchesDiagram('dia')).toBe(true);
    expect(matchesDiagram('DIAGRAM')).toBe(true);
    expect(matchesDiagram('diagrams')).toBe(false);
    expect(matchesDiagram('table')).toBe(false);
    const doc = '---\ntitle: x\n---\n\nbody /';
    expect(inFrontmatter(doc, 8)).toBe(true);
    expect(inFrontmatter(doc, doc.length)).toBe(false);
    expect(inFrontmatter('no frontmatter /', 16)).toBe(false);
  });

  it('writes a well-formed PNG: signature, then IHDR / tEXt / IDAT / IEND', () => {
    // (That a browser decodes it is checked in e2e/drawio.spec.ts.)
    const png = placeholderDiagramPng(EMPTY_DIAGRAM_XML);
    expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const types: string[] = [];
    for (let offset = 8; offset < png.length; offset += 12 + view.getUint32(offset)) {
      types.push(String.fromCharCode(...png.subarray(offset + 4, offset + 8)));
    }
    expect(types).toEqual(['IHDR', 'tEXt', 'IDAT', 'IEND']);
    // The well-known CRC of an empty IEND chunk proves the checksum routine.
    expect(view.getUint32(png.length - 4)).toBe(0xae426082);
  });

  it('keeps non-ASCII diagram text through the PNG chunk', () => {
    expect(pngDiagramXml(placeholderDiagramPng(BOX_XML))).toBe(BOX_XML);
  });

  it('refuses a picture that carries no diagram', () => {
    expect(diagramXmlOf('svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toBeNull();
    expect(diagramXmlOf('svg', '<html></html>')).toBeNull();
    expect(pngDiagramXml(Uint8Array.from([1, 2, 3]))).toBeNull();
    const plain = pictureWithDiagram(placeholderDiagramPng(''), BOX_XML) as Uint8Array;
    // Strip the diagram chunk again by building a PNG without one.
    expect(pngDiagramXml(plain)).toBe(BOX_XML);
    expect(pictureWithDiagram(Uint8Array.from([1, 2, 3]), BOX_XML)).toBeNull();
  });

  it('replaces the diagram data of a picture without touching the rest', () => {
    const svg = pictureWithDiagram(emptyDiagramSvg(), BOX_XML) as string;
    expect(diagramXmlOf('svg', svg)).toBe(BOX_XML);
    expect(svg).toContain('Empty diagram');

    const png = pictureWithDiagram(placeholderDiagramPng(''), BOX_XML) as Uint8Array;
    expect(pngDiagramXml(png)).toBe(BOX_XML);
    // Exactly one diagram chunk: the old one is gone, not shadowed.
    const text = String.fromCharCode(...png);
    expect(text.split('mxfile\0').length - 1).toBe(1);
  });
});

describe('drawio plugin: embed session (ADR-0064)', () => {
  interface Harness {
    session: EmbedSession;
    posted: Record<string, unknown>[];
    written: (string | Uint8Array)[];
    errors: string[];
    /** Runs the pending debounce timer, if any. */
    fire(): void;
    timers(): number;
  }

  function harness(options: EmbedSessionOptions, write?: () => Promise<void>): Harness {
    const posted: Record<string, unknown>[] = [];
    const written: (string | Uint8Array)[] = [];
    const errors: string[] = [];
    const pending = new Map<number, () => void>();
    let next = 1;
    const session = new EmbedSession(options, {
      post: (message) => posted.push(message),
      write: async (content) => {
        written.push(content);
        await write?.();
      },
      setTimer: (run) => {
        pending.set(next, run);
        return next++;
      },
      clearTimer: (handle) => void pending.delete(handle as number),
      onError: (message) => errors.push(message),
    });
    return {
      session,
      posted,
      written,
      errors,
      fire: () => {
        const runs = [...pending.values()];
        pending.clear();
        runs.forEach((run) => run());
      },
      timers: () => pending.size,
    };
  }

  const event = (payload: Record<string, unknown>): string => JSON.stringify(payload);
  const svgData = (svg: string): string =>
    `data:image/svg+xml;base64,${btoa(String.fromCharCode(...new TextEncoder().encode(svg)))}`;
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('builds an offline, English frame URL without Save / Exit buttons', () => {
    const url = new URL(editorFrameUrl('plugin://drawio/webapp', true));
    expect(url.pathname).toBe('/webapp/index.html');
    const params = url.searchParams;
    expect(params.get('embed')).toBe('1');
    expect(params.get('proto')).toBe('json');
    expect(params.get('offline')).toBe('1');
    expect(params.get('stealth')).toBe('1');
    expect(params.get('lang')).toBe('en');
    expect(params.get('noSaveBtn')).toBe('1');
    expect(params.get('noExitBtn')).toBe('1');
    expect(params.get('dark')).toBe('1');
    expect(new URL(editorFrameUrl('plugin://drawio/webapp', false)).searchParams.get('dark')).toBe('0');
  });

  it('answers init with the diagram and autosave on', () => {
    const h = harness({ format: 'xml', xml: '<mxfile/>' });
    h.session.handle(event({ event: 'init' }));
    expect(h.posted).toEqual([{ action: 'load', xml: '<mxfile/>', autosave: 1 }]);
    expect(h.session.isLoaded).toBe(false);
    h.session.handle(event({ event: 'load' }));
    expect(h.session.isLoaded).toBe(true);
  });

  it('ignores what is not a protocol message', () => {
    const h = harness({ format: 'xml', xml: '' });
    h.session.handle({ event: 'init' });
    h.session.handle('not json');
    h.session.handle('42');
    expect(h.posted).toEqual([]);
  });

  it('writes a .drawio after the quiet time, once for a burst of changes', async () => {
    const h = harness({ format: 'xml', xml: '' });
    h.session.handle(event({ event: 'load' }));
    h.session.handle(event({ event: 'autosave', xml: '<a/>' }));
    h.session.handle(event({ event: 'autosave', xml: '<b/>' }));
    expect(h.written).toEqual([]);
    expect(h.timers()).toBe(1);
    h.fire();
    await settle();
    expect(h.written).toEqual(['<b/>']);
    expect(h.posted.at(-1)).toEqual({ action: 'status', modified: false });
  });

  it('does not treat messages before the load as changes', () => {
    const h = harness({ format: 'xml', xml: '' });
    h.session.handle(event({ event: 'autosave', xml: '<a/>' }));
    expect(h.timers()).toBe(0);
  });

  it('writes at once on an explicit save', async () => {
    const h = harness({ format: 'xml', xml: '' });
    h.session.handle(event({ event: 'load' }));
    h.session.handle(event({ event: 'save', xml: '<a/>' }));
    await settle();
    expect(h.written).toEqual(['<a/>']);
    expect(h.timers()).toBe(0);
  });

  it('asks for a picture on every change, one export at a time', async () => {
    const h = harness({ format: 'svg', xml: '' });
    h.session.handle(event({ event: 'load' }));
    h.session.handle(event({ event: 'autosave', xml: '<a/>' }));
    h.session.handle(event({ event: 'autosave', xml: '<b/>' }));
    expect(h.posted).toEqual([{ action: 'export', format: 'xmlsvg' }]);

    h.session.handle(event({ event: 'export', data: svgData('<svg>ä1</svg>') }));
    // The change that arrived meanwhile gets its own export.
    expect(h.posted).toEqual([
      { action: 'export', format: 'xmlsvg' },
      { action: 'export', format: 'xmlsvg' },
    ]);
    h.session.handle(event({ event: 'export', data: svgData('<svg>ä2</svg>') }));
    h.fire();
    await settle();
    expect(h.written).toEqual(['<svg>ä2</svg>']);
  });

  it('exports a PNG as bytes', async () => {
    const h = harness({ format: 'png', xml: '' });
    h.session.handle(event({ event: 'load' }));
    h.session.handle(event({ event: 'autosave', xml: '<a/>' }));
    expect(h.posted).toEqual([{ action: 'export', format: 'xmlpng' }]);
    h.session.handle(event({ event: 'export', data: `data:image/png;base64,${btoa('\x89PNG')}` }));
    h.fire();
    await settle();
    expect(h.written).toHaveLength(1);
    expect(Array.from(h.written[0] as Uint8Array)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('reports an export that carries no picture', () => {
    const h = harness({ format: 'svg', xml: '' });
    h.session.handle(event({ event: 'load' }));
    h.session.handle(event({ event: 'autosave', xml: '<a/>' }));
    h.session.handle(event({ event: 'export', data: 'nonsense' }));
    expect(h.errors).toEqual(['The editor returned no picture for this diagram.']);
    expect(h.timers()).toBe(0);
  });

  it('writes the pending picture when the tab closes', async () => {
    const h = harness({ format: 'svg', xml: '' });
    h.session.handle(event({ event: 'load' }));
    h.session.handle(event({ event: 'autosave', xml: '<a/>' }));
    h.session.handle(event({ event: 'export', data: svgData('<svg>1</svg>') }));
    await h.session.dispose();
    expect(h.written).toEqual(['<svg>1</svg>']);
    expect(h.timers()).toBe(0);
    // Closed: later frame messages change nothing.
    h.session.handle(event({ event: 'autosave', xml: '<b/>' }));
    expect(h.posted.filter((m) => m['action'] === 'export')).toHaveLength(1);
  });

  it('keeps the newest diagram when the tab closes before its picture arrived', async () => {
    const h = harness({
      format: 'svg',
      xml: '',
      original: emptyDiagramSvg(),
      withDiagram: pictureWithDiagram,
    });
    h.session.handle(event({ event: 'load' }));
    h.session.handle(event({ event: 'autosave', xml: BOX_XML }));
    await h.session.dispose();
    expect(h.written).toHaveLength(1);
    expect(diagramXmlOf('svg', h.written[0] as string)).toBe(BOX_XML);
  });

  it('stops writing once the file is gone', async () => {
    const h = harness({ format: 'xml', xml: '' });
    h.session.handle(event({ event: 'load' }));
    h.session.handle(event({ event: 'autosave', xml: '<a/>' }));
    h.session.abandon();
    h.fire();
    await h.session.dispose();
    expect(h.written).toEqual([]);
  });

  it('reports a failed write and keeps going', async () => {
    const h = harness({ format: 'xml', xml: '' }, () => Promise.reject(new Error('disk full')));
    h.session.handle(event({ event: 'load' }));
    h.session.handle(event({ event: 'save', xml: '<a/>' }));
    await settle();
    expect(h.errors).toEqual(['disk full']);
    h.session.handle(event({ event: 'save', xml: '<b/>' }));
    await settle();
    expect(h.written).toEqual(['<a/>', '<b/>']);
  });
});
