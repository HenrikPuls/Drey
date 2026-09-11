import { TestBed } from '@angular/core/testing';
import { EditorContextMenuService } from './editor-context-menu.service';

describe('EditorContextMenuService', () => {
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

  it('close() clears the anchor', () => {
    const host = document.createElement('div');
    host.className = 'cm-editor';
    document.body.appendChild(host);
    rightClick(host);
    expect(svc.anchor()).not.toBeNull();

    svc.close();
    expect(svc.anchor()).toBeNull();
  });
});
