import { Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { EditorView } from '@codemirror/view';
import { DreyApi } from '../../../shared/ipc-api';
import { normalizeAppConfig } from '../../../shared/app-config';
import { mountMarkdownView } from './markdown-view';

describe('mountMarkdownView (ui.createMarkdownView)', () => {
  beforeAll(() => {
    const rect = { x: 0, y: 0, top: 0, left: 0, right: 10, bottom: 16, width: 10, height: 16, toJSON: () => ({}) } as DOMRect;
    Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
  });

  beforeEach(() => {
    const fakeApi: Partial<DreyApi> = {
      getConfig: () => Promise.resolve(normalizeAppConfig({})),
    };
    window.dreyApi = fakeApi as DreyApi;
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  it('mounts the host editor into a plain element and shows the content', () => {
    const handle = mountMarkdownView(TestBed.inject(Injector), { content: '# Title\n\nsome **bold** text' });
    document.body.append(handle.element);
    expect(handle.element.querySelector('.cm-editor')).toBeTruthy();
    expect(handle.getContent()).toContain('some **bold** text');
    handle.dispose();
    expect(handle.element.isConnected).toBe(false);
  });

  it('replaces the text programmatically, also while read-only', () => {
    const handle = mountMarkdownView(TestBed.inject(Injector), { readOnly: true, content: 'one' });
    handle.setContent('two');
    expect(handle.getContent()).toBe('two');
    handle.dispose();
  });

  it('mounts in the rendered view mode and still takes programmatic text', () => {
    const handle = mountMarkdownView(TestBed.inject(Injector), { mode: 'view', content: 'plain' });
    document.body.append(handle.element);
    handle.setContent('# Heading\n\nbody');
    expect(handle.getContent()).toBe('# Heading\n\nbody');
    handle.dispose();
  });

  it('keeps the selection when a refresh re-delivers mostly the same text', () => {
    const handle = mountMarkdownView(TestBed.inject(Injector), { mode: 'view', content: 'aaa\n\nbbb\n\nccc' });
    document.body.append(handle.element);
    const view = EditorView.findFromDOM(handle.element.querySelector('.cm-editor') as HTMLElement)!;
    view.dispatch({ selection: { anchor: 5, head: 8 } }); // "bbb"

    handle.setContent('aaa\n\nbbb\n\nccc\n\nddd'); // a line was appended
    expect(view.state.selection.main.from).toBe(5);
    expect(view.state.selection.main.to).toBe(8);

    handle.setContent('bbb\n\nccc\n\nddd'); // the head was trimmed
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('bbb');

    handle.setContent('bbb\n\nccc\n\nddd'); // nothing changed: no dispatch at all
    expect(handle.getContent()).toBe('bbb\n\nccc\n\nddd');
    handle.dispose();
  });

  it('ignores calls after dispose', () => {
    const handle = mountMarkdownView(TestBed.inject(Injector), { content: 'a' });
    handle.dispose();
    expect(() => handle.setContent('b')).not.toThrow();
    expect(() => handle.dispose()).not.toThrow();
  });
});
