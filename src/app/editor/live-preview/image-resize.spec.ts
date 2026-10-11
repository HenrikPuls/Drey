import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { livePreview } from './index';

/**
 * The `.lp-resize` grip drag: a real `EditorView` over a live-preview
 * document, driven by synthetic pointer events, must rewrite the note's
 * `![alt|W](url)` on release. jsdom has no layout, so `startWidth` falls
 * back to 300 and the assertions are delta-based.
 *
 * Assertions POLL: the rewrite lands through CodeMirror's update cycle and
 * (for the widget geometry) the browser's frame scheduling, so a
 * single-shot read after `pointerup` intermittently beats it on a loaded
 * machine.
 */
function makeView(doc: string): EditorView {
  return new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      // Selection at the end so the image widget renders (not revealed).
      selection: { anchor: doc.length },
      extensions: [markdown({ base: markdownLanguage }), livePreview({ resolveImage: (u) => [u] })],
    }),
  });
}

function drag(view: EditorView, deltaX: number): void {
  const grip = view.dom.querySelector('.lp-resize') as HTMLElement;
  expect(grip).not.toBeNull();
  grip.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: 0 }),
  );
  window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: deltaX }));
  window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: deltaX }));
}

describe('image resize handle', () => {
  let view: EditorView | undefined;

  afterEach(() => {
    view?.destroy();
    view = undefined;
  });

  it('adds a |W suffix to an image that had none (startWidth 300 + delta)', async () => {
    view = makeView('# t\n\n![a boat](x.png)\n');
    drag(view, 80);
    await vi.waitFor(() =>
      expect(view!.state.doc.toString()).toBe('# t\n\n![a boat|380](x.png)\n'),
    );
  });

  it('updates an existing |W', async () => {
    view = makeView('# t\n\n![a boat|150](x.png)\n');
    drag(view, -40);
    await vi.waitFor(() =>
      expect(view!.state.doc.toString()).toBe('# t\n\n![a boat|260](x.png)\n'),
    );
  });

  it('collapses an existing |WxH to width only', async () => {
    view = makeView('# t\n\n![plan|150x90](x.png)\n');
    drag(view, 20);
    await vi.waitFor(() =>
      expect(view!.state.doc.toString()).toBe('# t\n\n![plan|320](x.png)\n'),
    );
  });

  it('does not touch the selection or reveal the widget', async () => {
    const doc = '# t\n\n![a](x.png)\n';
    view = makeView(doc);
    const anchorBefore = view.state.selection.main.anchor;
    drag(view, 30);
    // one changes transaction, selection mapped through it but not set
    await vi.waitFor(() =>
      expect(view!.state.doc.toString()).toBe('# t\n\n![a|330](x.png)\n'),
    );
    expect(view.state.selection.main.anchor).toBe(anchorBefore + '|330'.length);
    expect(view.dom.querySelector('.lp-image')).not.toBeNull();
  });

  it('resizes an image the initial parse has not reached yet', () => {
    // A new state parses only its first 3000 characters up front; the rest
    // follows in the background. The grip must not depend on that.
    const filler = `${'word '.repeat(800)}\n\n`;
    view = makeView(`# t\n\n${filler}![a boat](x.png)\n`);
    drag(view, 80);
    expect(view.state.doc.toString()).toBe(`# t\n\n${filler}![a boat|380](x.png)\n`);
  });

  it('makes no edit when the width is unchanged', async () => {
    view = makeView('# t\n\n![a boat|300](x.png)\n');
    drag(view, 0);
    // Give the handler every chance to misfire before asserting the no-op.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(view.state.doc.toString()).toBe('# t\n\n![a boat|300](x.png)\n');
  });

  it('window blur mid-drag ends the gesture: body chrome restored, no leak (bug-6)', async () => {
    view = makeView('# t\n\n![a boat](x.png)\n');
    const grip = view.dom.querySelector('.lp-resize') as HTMLElement;
    grip.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: 0 }),
    );
    window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 80 }));
    expect(document.body.style.userSelect).toBe('none');

    // An alt-tab mid-drag: the pointerup may never fire, so the blur itself
    // must tear the gesture down instead of leaving <body> unselectable.
    window.dispatchEvent(new Event('blur'));

    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
    // Blur counts as the gesture's end -- the buffered rewrite still lands.
    await vi.waitFor(() =>
      expect(view!.state.doc.toString()).toBe('# t\n\n![a boat|380](x.png)\n'),
    );
  });
});