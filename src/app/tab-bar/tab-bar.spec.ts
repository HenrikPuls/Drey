import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TabBar } from './tab-bar';
import { EditorService } from '../services/editor.service';
import { PaneService } from '../panes/pane.service';
import { DreyApi } from '../../../shared/ipc-api';

describe('TabBar', () => {
  let fixture: ComponentFixture<TabBar>;
  let editor: EditorService;
  let panes: PaneService;

  beforeEach(async () => {
    const fakeApi: Partial<DreyApi> = {
      readVaultFile: (p: string) => Promise.resolve({ content: `body of ${p}`, modifiedMs: 1 }),
      writeVaultFile: () => Promise.resolve(2),
    };
    window.dreyApi = fakeApi as DreyApi;

    await TestBed.configureTestingModule({ imports: [TabBar] }).compileComponents();
    editor = TestBed.inject(EditorService);
    panes = TestBed.inject(PaneService);
    await editor.openFile('a.md');
    await editor.openFile('b.md');

    fixture = TestBed.createComponent(TabBar);
    fixture.componentRef.setInput('paneId', 'p1'); // the single pane both docs land in
    fixture.detectChanges();
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
    // Belt-and-braces: clear any drag chrome a test left mounted on <body>.
    document.querySelectorAll('.drag-overlay, .tab-drag-ghost').forEach((el) => el.remove());
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    document.body.removeAttribute('data-drey-gesture');
  });

  /** A real left-button press (mousedown + mouseup) on `el`, below the drag threshold. */
  function press(el: HTMLElement): void {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 5, clientY: 0 }));
    window.dispatchEvent(new MouseEvent('mouseup'));
  }

  it('shows one tab per open document, highlighting the active one', () => {
    const tabs = (fixture.nativeElement as HTMLElement).querySelectorAll('.tab');
    expect(Array.from(tabs).map((t) => t.querySelector('.name')?.textContent)).toEqual([
      'a.md',
      'b.md',
    ]);
    expect(tabs[1].classList.contains('active')).toBe(true);
  });

  it('activates a tab on a plain press and closes one via its X', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    press(compiled.querySelectorAll('.tab')[0] as HTMLElement);
    fixture.detectChanges();
    expect(editor.openPath()).toBe('a.md');

    (compiled.querySelectorAll('.tab .close')[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(editor.openDocs().map((d) => d.path)).toEqual(['a.md']);
  });

  it('defers a tab reorder to the drop: nothing moves until mouseup (ADR-0039)', async () => {
    await editor.openFile('c.md');
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    const tabs = Array.from(compiled.querySelectorAll<HTMLElement>('.tab'));
    expect(tabs.length).toBe(3); // a.md, b.md, c.md

    // jsdom lays out nothing -- stub each tab's rect (and `elementFromPoint`,
    // which the TabDragService hit-test calls) so the midpoint math has real
    // numbers.
    const rects = [
      { left: 0, width: 100 },
      { left: 100, width: 100 },
      { left: 200, width: 100 },
    ];
    tabs.forEach((el, i) => {
      el.getBoundingClientRect = () =>
        ({ left: rects[i].left, width: rects[i].width, right: 0, top: 0, bottom: 0, height: 0 }) as DOMRect;
    });
    const host = fixture.nativeElement as HTMLElement; // the tab strip (data-tabstrip-pane="p1")
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => host,
    });

    try {
      tabs[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 10 }));
      fixture.detectChanges();
      expect(panes.pane('p1')!.tabs).toEqual(['a.md', 'b.md', 'c.md']); // not yet promoted

      // Past the threshold and past every tab's midpoint: the drop *would*
      // land at the end -- a drop-line shows there, but the list is unchanged.
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 280 }));
      fixture.detectChanges();
      expect(panes.pane('p1')!.tabs).toEqual(['a.md', 'b.md', 'c.md']); // deferred
      expect(compiled.querySelector('.tab.dragging')).not.toBeNull();
      expect(compiled.querySelector('.drop-line')).not.toBeNull();
      expect(document.querySelector('.tab-drag-ghost')?.textContent).toContain('a.md');
      expect(document.querySelector('.drag-overlay')).not.toBeNull();

      // The move commits once, on release.
      window.dispatchEvent(new MouseEvent('mouseup'));
      fixture.detectChanges();
      expect(panes.pane('p1')!.tabs).toEqual(['b.md', 'c.md', 'a.md']);
      expect(compiled.querySelector('.tab.dragging')).toBeNull();
      expect(compiled.querySelector('.drop-line')).toBeNull();
      expect(document.querySelector('.drag-overlay')).toBeNull();
      expect(document.body.hasAttribute('data-drey-gesture')).toBe(false);
    } finally {
      delete (document as unknown as Record<string, unknown>)['elementFromPoint'];
    }
  });

  it('offers "Split right" / "Split down" / "Close others" / "Close all" from the tab context menu', async () => {
    await editor.openFile('c.md');
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;

    compiled
      .querySelectorAll('.tab')[1]
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
    fixture.detectChanges();

    const items = compiled.querySelectorAll('.ctx-menu button');
    expect(Array.from(items).map((b) => b.textContent?.trim())).toEqual([
      'Split right',
      'Split down',
      'Close others',
      'Close all',
    ]);

    (items[2] as HTMLButtonElement).click(); // "Close others" (keeps b.md, the row that was right-clicked)
    fixture.detectChanges();
    expect(editor.openDocs().map((d) => d.path)).toEqual(['b.md']);
    expect(compiled.querySelector('.ctx-menu')).toBeNull();
  });

  it('"Split right" moves the tab into a brand-new sibling pane', async () => {
    const compiled = fixture.nativeElement as HTMLElement;
    compiled
      .querySelectorAll('.tab')[0]
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
    fixture.detectChanges();

    (compiled.querySelector('.ctx-menu button') as HTMLButtonElement).click(); // "Split right"
    fixture.detectChanges();

    expect(panes.pane('p1')!.tabs).toEqual(['b.md']);
    const newPaneId = panes.paneIds().find((id) => id !== 'p1')!;
    expect(panes.pane(newPaneId)!.tabs).toEqual(['a.md']);
    expect(panes.focusedId()).toBe(newPaneId);
  });
});
