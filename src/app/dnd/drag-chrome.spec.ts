import {
  endDragChrome,
  hitTestUnderPointer,
  isDragChromeActive,
  moveDragChrome,
  setDragCursor,
  startDragChrome,
} from './drag-chrome';

describe('drag-chrome', () => {
  afterEach(() => endDragChrome());

  it('mounts the overlay + ghost and sets the body gesture flags', () => {
    startDragChrome({ gesture: 'tab-drag', ghostClass: 'tab-drag-ghost', ghostHtml: 'note.md' });

    const overlay = document.querySelector('.drag-overlay') as HTMLElement;
    const ghost = document.querySelector('.tab-drag-ghost') as HTMLElement;
    expect(overlay).not.toBeNull();
    expect(ghost.textContent).toBe('note.md');
    expect(document.body.style.userSelect).toBe('none');
    expect(document.body.style.cursor).toBe('grabbing');
    expect(document.body.getAttribute('data-drey-gesture')).toBe('tab-drag');
    expect(isDragChromeActive()).toBe(true);
  });

  it('is idempotent -- a second start replaces, never stacks', () => {
    startDragChrome({ gesture: 'dock', ghostClass: 'dock-drag-ghost', ghostHtml: 'A' });
    startDragChrome({ gesture: 'dock', ghostClass: 'dock-drag-ghost', ghostHtml: 'B' });
    expect(document.querySelectorAll('.drag-overlay')).toHaveLength(1);
    expect(document.querySelectorAll('.dock-drag-ghost')).toHaveLength(1);
    expect(document.querySelector('.dock-drag-ghost')?.textContent).toBe('B');
  });

  it('setDragCursor switches the overlay + body cursor', () => {
    startDragChrome({ gesture: 'tab-drag', ghostClass: 'tab-drag-ghost', ghostHtml: 'x' });
    setDragCursor('no-drop');
    expect((document.querySelector('.drag-overlay') as HTMLElement).style.cursor).toBe('no-drop');
    expect(document.body.style.cursor).toBe('no-drop');
  });

  it('moveDragChrome positions the ghost off the cursor', () => {
    startDragChrome({ gesture: 'tab-drag', ghostClass: 'tab-drag-ghost', ghostHtml: 'x' });
    moveDragChrome(100, 200);
    expect((document.querySelector('.tab-drag-ghost') as HTMLElement).style.transform).toBe(
      'translate(114px, 212px)',
    );
  });

  it('hitTestUnderPointer ignores the overlay and restores its pointer-events', () => {
    startDragChrome({ gesture: 'tab-drag', ghostClass: 'tab-drag-ghost', ghostHtml: 'x' });
    const overlay = document.querySelector('.drag-overlay') as HTMLElement;
    const target = document.createElement('div');
    document.body.appendChild(target);
    let seen: string | null = null;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => {
        seen = overlay.style.pointerEvents; // what it looks like *during* the call
        return target;
      },
    });

    try {
      expect(hitTestUnderPointer(1, 1)).toBe(target);
      expect(seen).toBe('none'); // suppressed for the probe
      expect(overlay.style.pointerEvents).toBe(''); // ...and put back
    } finally {
      delete (document as unknown as Record<string, unknown>)['elementFromPoint'];
      target.remove();
    }
  });

  it('endDragChrome removes everything and clears the body flags', () => {
    startDragChrome({ gesture: 'tab-drag', ghostClass: 'tab-drag-ghost', ghostHtml: 'x' });
    endDragChrome();
    expect(document.querySelector('.drag-overlay')).toBeNull();
    expect(document.querySelector('.tab-drag-ghost')).toBeNull();
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
    expect(document.body.hasAttribute('data-drey-gesture')).toBe(false);
    expect(isDragChromeActive()).toBe(false);
  });
});
