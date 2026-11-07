import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { TabBar } from './tab-bar';
import { EditorService } from '../services/editor.service';
import { PaneService } from '../panes/pane.service';
import { KeybindingService } from '../keybindings';
import { ViewService } from '../views';
import { DreyApi } from '../../../shared/ipc-api';

describe('TabBar', () => {
  let fixture: ComponentFixture<TabBar>;
  let editor: EditorService;
  let panes: PaneService;

  beforeEach(async () => {
    localStorage.clear(); // saved views would outlive the test that made them
    const fakeApi: Partial<DreyApi> = {
      readVaultFile: (p: string) => Promise.resolve({ content: `body of ${p}`, modifiedMs: 1 }),
      writeVaultFile: () => Promise.resolve(2),
    };
    window.dreyApi = fakeApi as DreyApi;

    await TestBed.configureTestingModule({ imports: [TabBar] }).compileComponents();
    editor = TestBed.inject(EditorService);
    panes = TestBed.inject(PaneService);
    await editor.openFile('a.md');
    // keepFocused: the strip needs both tabs; openFile's default would
    // replace the clean focused one (the behaviour its own specs cover).
    await editor.openFile('b.md', undefined, { keepFocused: true });

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
    await editor.openFile('c.md', undefined, { keepFocused: true });
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
    } finally {
      delete (document as unknown as Record<string, unknown>)['elementFromPoint'];
    }
  });

  it('offers "Split right" / "Split down" / "Export as PDF…" / "Close others" / "Close all" from the tab context menu', async () => {
    // The split rows print the chords in effect of these commands (ADR-0073).
    const keys = TestBed.inject(KeybindingService);
    keys.register({ id: 'pane.splitRight', label: 'Split right', keybinding: 'Mod+Alt+Enter', run: () => {} });
    keys.register({ id: 'pane.splitDown', label: 'Split down', keybinding: 'Mod+Alt+Shift+Enter', run: () => {} });
    await editor.openFile('c.md', undefined, { keepFocused: true });
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;

    compiled
      .querySelectorAll('.tab')[1]
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
    fixture.detectChanges();

    const items = compiled.querySelectorAll('.ctx-menu button');
    expect(Array.from(items).map((b) => b.textContent?.trim())).toEqual([
      'Close tab',
      'Move to left dock',
      'Move to right dock',
      'Move to bottom dock',
      'Split right Ctrl Alt Enter',
      'Split down Ctrl Alt Shift Enter',
      'Pin tab',
      'Export as PDF…',
      'Close others',
      'Close all',
    ]);

    (items[8] as HTMLButtonElement).click(); // "Close others" (keeps b.md, the row that was right-clicked)
    // closeOthers closes tab by tab through async closeTab calls.
    await vi.waitFor(() => expect(editor.openDocs().map((d) => d.path)).toEqual(['b.md']));
    fixture.detectChanges();
    expect(compiled.querySelector('.ctx-menu')).toBeNull();
  });

  it('"Pin tab" pins the right-clicked tab, shows the pin and flips to "Unpin tab"', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const openMenu = (): void => {
      compiled
        .querySelectorAll('.tab')[0]
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
      fixture.detectChanges();
    };

    const pinRow = (): HTMLButtonElement =>
      [...compiled.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find((b) => /Pin tab|Unpin tab/.test(b.textContent ?? ''))!;
    openMenu();
    pinRow().click();
    fixture.detectChanges();
    expect(editor.docFor('a.md')?.pinned).toBe(true);
    expect(compiled.querySelectorAll('.tab')[0].querySelector('.pin')).not.toBeNull();
    expect(compiled.querySelectorAll('.tab')[1].querySelector('.pin')).toBeNull();

    openMenu();
    expect(pinRow().textContent?.trim()).toBe('Unpin tab');
  });

  it('"Split right" moves the tab into a brand-new sibling pane', async () => {
    const compiled = fixture.nativeElement as HTMLElement;
    compiled
      .querySelectorAll('.tab')[0]
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
    fixture.detectChanges();

    const splitRight = [...compiled.querySelectorAll('.ctx-menu button')].find(
      (b) => b.textContent?.trim().startsWith('Split right'),
    ) as HTMLButtonElement;
    splitRight.click();
    fixture.detectChanges();

    expect(panes.pane('p1')!.tabs).toEqual(['b.md']);
    const newPaneId = panes.paneIds().find((id) => id !== 'p1')!;
    expect(panes.pane(newPaneId)!.tabs).toEqual(['a.md']);
    expect(panes.focusedId()).toBe(newPaneId);
  });

  it('draws the views inline and "Go to the Work view" when other views exist (board 7i)', () => {
    const views = TestBed.inject(ViewService);
    const second = views.saveCurrentAs('Work'); // a.md and b.md now show in both views
    views.switchTo('notes');
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    compiled
      .querySelectorAll('.tab')[0]
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
    fixture.detectChanges();

    // No flyout (D-39 goes with it): the head, the views, then Go to and Close tab.
    expect(compiled.querySelector('.ctx-label')?.textContent).toContain('Show this tab in');
    expect(compiled.querySelector('.ctx-sub')).toBeNull();
    const names = [...compiled.querySelectorAll('.ctx-menu > button.ctx-view .ctx-grow')].map((b) => b.textContent?.trim());
    expect(names).toEqual(['Notes', 'Work']);
    const rows = [...compiled.querySelectorAll<HTMLButtonElement>('.ctx-menu > button:not(.ctx-view)')];
    expect(rows[0]?.textContent).toContain('Go to the Work view');
    expect(rows[1]?.textContent).toContain('Close tab');

    rows[0]!.click();
    expect(views.activeId()).toBe(second);
  });

  it('offers Go to for a view that does not show the tab: it switches and adds nothing (board 7i)', () => {
    const views = TestBed.inject(ViewService);
    const second = views.saveCurrentAs('Work');
    const compiled = fixture.nativeElement as HTMLElement;
    views.switchTo('notes');
    fixture.detectChanges();
    compiled
      .querySelectorAll('.tab')[0]
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
    fixture.detectChanges();
    const tabPath = panes.pane(panes.focusedId())!.tabs[0]!;
    views.toggleTabIn(tabPath, second);
    fixture.detectChanges();
    expect(views.viewsOfTab(tabPath)).not.toContain(second);
    const row = [...compiled.querySelectorAll<HTMLButtonElement>('.ctx-menu > button')].find((button) => button.textContent?.includes('Go to the Work view'));
    expect(row).toBeDefined();
    row!.click();
    expect(views.activeId()).toBe(second);
    expect(views.viewsOfTab(tabPath)).not.toContain(second);
  });

  it('closes the tab from the menu', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const closeTab = vi.spyOn(TestBed.inject(EditorService), 'closeTab').mockResolvedValue(undefined as never);
    const views = TestBed.inject(ViewService);
    views.saveCurrentAs('Work');
    views.switchTo('notes');
    fixture.detectChanges();
    compiled
      .querySelectorAll('.tab')[0]
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
    fixture.detectChanges();
    const row = [...compiled.querySelectorAll<HTMLButtonElement>('.ctx-menu > button')].find((button) => button.textContent?.includes('Close tab'));
    row!.click();
    expect(closeTab).toHaveBeenCalledTimes(1);
  });
});
