import { TestBed } from '@angular/core/testing';
import { PaneService } from '../panes/pane.service';
import { TabDragService } from './tab-drag.service';

/** A detached tab strip with `n` stub `.tab` children at 100px each. */
function fakeBar(paneId: string, n: number): HTMLElement {
  const bar = document.createElement('div');
  bar.setAttribute('data-tabstrip-pane', paneId);
  for (let i = 0; i < n; i++) {
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.getBoundingClientRect = () =>
      ({ left: i * 100, width: 100, right: 0, top: 0, bottom: 0, height: 0 }) as DOMRect;
    bar.appendChild(tab);
  }
  document.body.appendChild(bar);
  return bar;
}

function fakeLeaf(paneId: string): HTMLElement {
  const leaf = document.createElement('div');
  leaf.setAttribute('data-pane-id', paneId);
  document.body.appendChild(leaf);
  return leaf;
}

function stubPointTarget(el: Element): void {
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => el });
}

function down(svc: TabDragService, paneId: string, path: string): void {
  svc.beginPress(paneId, path, path, false, new MouseEvent('mousedown', { button: 0, clientX: 0, clientY: 0 }));
}
function move(x: number): void {
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: 0 }));
}
function up(): void {
  window.dispatchEvent(new MouseEvent('mouseup'));
}

describe('TabDragService', () => {
  let svc: TabDragService;
  let panes: PaneService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    svc = TestBed.inject(TabDragService);
    panes = TestBed.inject(PaneService);
    panes.open('a.md');
    panes.open('b.md'); // p1: [a.md, b.md]
  });

  afterEach(() => {
    window.dispatchEvent(new Event('blur')); // force teardown of any in-flight drag
    document
      .querySelectorAll('[data-tabstrip-pane], [data-pane-id], .drag-overlay, .tab-drag-ghost')
      .forEach((el) => el.remove());
    delete (document as unknown as Record<string, unknown>)['elementFromPoint'];
    document.body.removeAttribute('data-drey-gesture');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  it('a press that never clears the threshold activates the tab, no drag chrome', () => {
    down(svc, 'p1', 'a.md');
    move(2); // < 4px
    up();
    expect(svc.dragging()).toBeNull();
    expect(panes.pane('p1')!.active).toBe('a.md');
    expect(document.querySelector('.drag-overlay')).toBeNull();
  });

  it('promotes past the threshold: dragging set, chrome mounted, watchdog marker set', () => {
    stubPointTarget(document.body);
    down(svc, 'p1', 'a.md');
    move(20);
    expect(svc.dragging()?.path).toBe('a.md');
    expect(document.querySelector('.tab-drag-ghost')?.textContent).toContain('a.md');
    expect(document.querySelector('.drag-overlay')).not.toBeNull();
    expect(document.body.getAttribute('data-drey-gesture')).toBe('tab-drag');
  });

  it('over a tab strip: dropTarget is the slot from the pointer x; commits once on drop', () => {
    const bar = fakeBar('p1', 2);
    stubPointTarget(bar);
    down(svc, 'p1', 'a.md');
    move(250); // past both midpoints (50, 150) -> index 2
    expect(svc.dropTarget()).toEqual({ paneId: 'p1', index: 2, kind: 'strip' });
    expect(panes.pane('p1')!.tabs).toEqual(['a.md', 'b.md']); // deferred
    up();
    expect(panes.pane('p1')!.tabs).toEqual(['b.md', 'a.md']); // committed
    expect(document.body.hasAttribute('data-drey-gesture')).toBe(false);
  });

  it('over a pane body: dropTarget is "body", appended at the end', () => {
    const p2 = panes.splitPane('p1', 'row', 'b.md')!; // p1: [a.md], p2: [b.md]
    const leaf = fakeLeaf('p1');
    stubPointTarget(leaf);
    down(svc, p2, 'b.md');
    move(20);
    expect(svc.dropTarget()).toEqual({ paneId: 'p1', index: 1, kind: 'body' });
    up();
    expect(panes.pane('p1')!.tabs).toEqual(['a.md', 'b.md']);
  });

  it('over a non-pane area: no drop target, no-drop cursor, drop moves nothing', () => {
    stubPointTarget(document.body);
    down(svc, 'p1', 'a.md');
    move(20);
    expect(svc.dropTarget()).toBeNull();
    expect(document.body.style.cursor).toBe('no-drop');
    up();
    expect(panes.pane('p1')!.tabs).toEqual(['a.md', 'b.md']);
  });

  it('Escape during a drag cancels it -- no move', () => {
    const bar = fakeBar('p1', 2);
    stubPointTarget(bar);
    down(svc, 'p1', 'a.md');
    move(250);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(svc.dragging()).toBeNull();
    expect(document.querySelector('.drag-overlay')).toBeNull();
    up();
    expect(panes.pane('p1')!.tabs).toEqual(['a.md', 'b.md']);
  });

  it('the window losing focus mid-drag cancels it -- no move', () => {
    const bar = fakeBar('p1', 2);
    stubPointTarget(bar);
    down(svc, 'p1', 'a.md');
    move(250);
    window.dispatchEvent(new Event('blur'));
    expect(svc.dragging()).toBeNull();
    expect(panes.pane('p1')!.tabs).toEqual(['a.md', 'b.md']);
  });
});
