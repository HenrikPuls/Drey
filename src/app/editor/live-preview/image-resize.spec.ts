import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { livePreview } from './index';

/**
 * The `.lp-resize` grip drag: a real `EditorView` over a live-preview
 * document, driven by synthetic pointer events, must rewrite the note's
 * `![alt|W](url)` on release. jsdom has no layout, so `startWidth` falls
 * back to 300 and the assertions are delta-based.
 */
function makeView(doc: string): EditorView {
  return new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      // Selection at the end so the image widget renders (not revealed).
      selection: { anchor: doc.length },
      extensions: [markdown({ base: markdownLanguage }), livePreview({ resolveImage: (u) => u })],
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

  it('adds a |W suffix to an image that had none (startWidth 300 + delta)', () => {
    view = makeView('# t\n\n![a boat](x.png)\n');
    drag(view, 80);
    expect(view.state.doc.toString()).toBe('# t\n\n![a boat|380](x.png)\n');
  });

  it('updates an existing |W', () => {
    view = makeView('# t\n\n![a boat|150](x.png)\n');
    drag(view, -40);
    expect(view.state.doc.toString()).toBe('# t\n\n![a boat|260](x.png)\n');
  });

  it('collapses an existing |WxH to width only', () => {
    view = makeView('# t\n\n![plan|150x90](x.png)\n');
    drag(view, 20);
    expect(view.state.doc.toString()).toBe('# t\n\n![plan|320](x.png)\n');
  });

  it('does not touch the selection or reveal the widget', () => {
    const doc = '# t\n\n![a](x.png)\n';
    view = makeView(doc);
    const anchorBefore = view.state.selection.main.anchor;
    drag(view, 30);
    // one changes transaction, selection mapped through it but not set
    expect(view.state.selection.main.anchor).toBe(anchorBefore + '|330'.length);
    expect(view.dom.querySelector('.lp-image')).not.toBeNull();
  });

  it('makes no edit when the width is unchanged', () => {
    view = makeView('# t\n\n![a|300](x.png)\n');
    const before = view.state.doc.toString();
    drag(view, 0);
    expect(view.state.doc.toString()).toBe(before);
  });
});
