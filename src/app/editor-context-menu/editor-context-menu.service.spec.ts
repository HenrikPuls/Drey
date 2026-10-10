import { TestBed } from '@angular/core/testing';
import { EditorView } from '@codemirror/view';
import { EditorContextMenuRegistry } from '../plugin-host';
import {
  EditorContextMenuService,
  buildMenuTarget,
} from './editor-context-menu.service';

describe('EditorContextMenuService', () => {
  let svc: EditorContextMenuService;
  let registry: EditorContextMenuRegistry;

  beforeEach(() => {
    svc = TestBed.inject(EditorContextMenuService);
    registry = TestBed.inject(EditorContextMenuRegistry);
    svc.start();
  });

  afterEach(() => {
    svc.close();
    document.body.innerHTML = '';
  });

  function rightClick(target: Element): boolean {
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 100,
    });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }

  it('opens (and cancels the native menu) for a click inside a .cm-editor', () => {
    const host = document.createElement('div');
    host.className = 'cm-editor';
    const inner = document.createElement('div');
    inner.className = 'cm-content';
    host.appendChild(inner);
    document.body.appendChild(host);

    const prevented = rightClick(inner);

    expect(prevented).toBe(true);
    expect(svc.anchor()).not.toBeNull();
  });

  it('ignores a click on a plain input (native menu handles it)', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);

    const prevented = rightClick(input);

    expect(prevented).toBe(false);
    expect(svc.anchor()).toBeNull();
  });

  it('close() clears the anchor and the click target', () => {
    const host = document.createElement('div');
    host.className = 'cm-editor';
    document.body.appendChild(host);
    rightClick(host);
    expect(svc.anchor()).not.toBeNull();
    expect(svc.menuTarget()).not.toBeNull();

    svc.close();
    expect(svc.anchor()).toBeNull();
    expect(svc.menuTarget()).toBeNull();
  });

  it('reports an image-tab click as an image target', () => {
    // An image tab has no built-in rows — the menu only opens when a plugin
    // contributes at least one item (disabled rows count).
    const unregister = registry.register(() => [
      { label: 'Recognize text', run: () => undefined },
    ]);
    const host = document.createElement('div');
    host.setAttribute('data-drey-image', 'pics/a.png');
    const img = document.createElement('img');
    host.appendChild(img);
    document.body.appendChild(host);

    const prevented = rightClick(img);

    expect(prevented).toBe(true);
    expect(svc.menuTarget()).toEqual({ surface: 'image', imagePath: 'pics/a.png' });
    unregister(); // the registry is a root singleton — don't leak into other tests
  });

  it('does not open at all on an image tab when no plugin contributes rows', () => {
    const host = document.createElement('div');
    host.setAttribute('data-drey-image', 'pics/a.png');
    document.body.appendChild(host);

    const prevented = rightClick(host);

    expect(prevented).toBe(false);
    expect(svc.anchor()).toBeNull();
    expect(svc.menuTarget()).toBeNull();
  });

  it('carries the pane doc path for a pane editor, null for other CM surfaces', () => {
    const content = document.createElement('div');
    content.className = 'cm-content';
    const cmHost = document.createElement('div');
    cmHost.className = 'cm-editor';
    cmHost.appendChild(content);
    const pane = document.createElement('app-editor');
    pane.setAttribute('data-drey-doc', 'notes/n.md');
    pane.appendChild(cmHost);
    document.body.appendChild(pane);

    rightClick(content);
    expect(svc.menuTarget()).toEqual({
      surface: 'editor',
      docPath: 'notes/n.md',
      target: content,
      lineNumber: null, // no real CodeMirror view in jsdom
      lineText: null,
    });

    // The drawer guard: the same CM structure outside <app-editor> (the
    // entry drawer, a plugin composer) has no document to scope rows to.
    const drawerContent = document.createElement('div');
    drawerContent.className = 'cm-content';
    const drawerHost = document.createElement('div');
    drawerHost.className = 'cm-editor';
    drawerHost.appendChild(drawerContent);
    document.body.appendChild(drawerHost);

    rightClick(drawerContent);
    expect(svc.menuTarget()).toEqual({
      surface: 'editor',
      docPath: null,
      target: drawerContent,
      lineNumber: null,
      lineText: null,
    });
  });
});

describe('buildMenuTarget', () => {
  /** A stand-in EditorView: the geometry real jsdom layouts can't provide. */
  function fakeView(lineNumber: number, lineText: string): EditorView {
    return {
      posAtDOM: () => 42,
      state: {
        doc: {
          lineAt: () => ({ number: lineNumber, text: lineText }),
        },
      },
    } as unknown as EditorView;
  }

  const cmHost = (): HTMLElement => {
    const host = document.createElement('div');
    host.className = 'cm-editor';
    document.body.appendChild(host);
    return host;
  };

  it('maps the click to the view line under a pane editor', () => {
    const inner = document.createElement('span');
    cmHost().appendChild(inner);

    const target = buildMenuTarget(inner, () => fakeView(3, '![x](pics/a.png)'));

    expect(target).toEqual({
      surface: 'editor',
      docPath: null,
      target: inner,
      lineNumber: 3,
      lineText: '![x](pics/a.png)',
    });
  });

  it('falls back to null line info when the view lookup or mapping fails', () => {
    const inner = document.createElement('span');
    const host = cmHost();
    host.appendChild(inner);

    const noView = buildMenuTarget(inner, () => null);
    expect(noView).toEqual({
      surface: 'editor',
      docPath: null,
      target: inner,
      lineNumber: null,
      lineText: null,
    });

    const throwing = buildMenuTarget(inner, () => {
      throw new Error('not in view');
    });
    expect(throwing).toEqual({
      surface: 'editor',
      docPath: null,
      target: inner,
      lineNumber: null,
      lineText: null,
    });
  });

  it('returns null when the click is on neither surface', () => {
    const plain = document.createElement('div');
    document.body.appendChild(plain);

    expect(buildMenuTarget(plain, () => null)).toBeNull();
  });
});

describe('EditorContextMenuService.resolveView', () => {
  let svc: EditorContextMenuService;

  beforeEach(() => {
    svc = TestBed.inject(EditorContextMenuService);
    svc.start();
  });

  afterEach(() => {
    svc.close();
    document.body.innerHTML = '';
  });

  function rightClick(target: Element): boolean {
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 10,
    });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }

  /** A mounted CM view — stands in for e.g. the assistant composer. */
  function mountComposerView(): { host: HTMLElement; view: EditorView } {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = new EditorView({ parent: host });
    return { host, view };
  }

  it('resolves the view of the surface the menu was opened on', () => {
    const { view } = mountComposerView();

    expect(rightClick(view.contentDOM)).toBe(true);

    expect(svc.resolveView()).toBe(view);
  });

  it('returns null once the menu is closed', () => {
    const { view } = mountComposerView();
    rightClick(view.contentDOM);
    expect(svc.resolveView()).not.toBeNull();

    svc.close();

    expect(svc.resolveView()).toBeNull();
  });

  it('returns null for an image target (nothing editable behind it)', () => {
    const registry = TestBed.inject(EditorContextMenuRegistry);
    const unregister = registry.register(() => [
      { label: 'Recognize text', run: () => undefined },
    ]);
    const host = document.createElement('div');
    host.setAttribute('data-drey-image', 'pics/a.png');
    document.body.appendChild(host);

    rightClick(host);

    expect(svc.menuTarget()?.surface).toBe('image');
    expect(svc.resolveView()).toBeNull();
    unregister(); // the registry is a root singleton — don't leak into other tests
  });
});
