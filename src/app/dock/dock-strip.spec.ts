import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DockService } from './dock.service';
import { DockStrip } from './dock-strip';
import { WidgetRegistryService } from './widget-registry.service';

describe('DockStrip', () => {
  let fixture: ComponentFixture<DockStrip>;
  let dock: DockService;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({ imports: [DockStrip] }).compileComponents();
    dock = TestBed.inject(DockService);
    fixture = TestBed.createComponent(DockStrip);
    fixture.componentRef.setInput('side', 'left');
    fixture.detectChanges();
  });

  function buttons(): HTMLButtonElement[] {
    return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button'));
  }

  it('shows one toggle per panel of its dock, in dock order', () => {
    expect(buttons().map((b) => b.dataset['widget'])).toEqual(['calendar', 'files', 'windows']);
    expect(buttons().map((b) => b.getAttribute('aria-label'))).toEqual([
      'Hide Calendar',
      'Hide Files',
      'Hide Open windows',
    ]);
    expect(buttons().every((b) => b.getAttribute('aria-pressed') === 'true')).toBe(true);
  });

  it('a press without movement toggles the panel and the button follows', () => {
    buttons()[1].dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup'));
    fixture.detectChanges();
    expect(dock.closed('files')).toBe(true);
    expect(buttons()[1].getAttribute('aria-pressed')).toBe('false');
    expect(buttons()[1].getAttribute('aria-label')).toBe('Show Files');
  });

  it('a keyboard activation toggles; a mouse click alone does not toggle twice', () => {
    buttons()[1].dispatchEvent(new MouseEvent('click', { detail: 0, bubbles: true }));
    expect(dock.closed('files')).toBe(true);
    buttons()[1].dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true }));
    expect(dock.closed('files')).toBe(true);
  });

  it('carries the status of a closed panel in its tooltip', () => {
    dock.toggle('windows');
    fixture.detectChanges();
    expect(buttons()[2].title).toBe('Show Open windows · 0');
  });

  it('falls back to the first letter for a plugin widget without an icon', () => {
    TestBed.inject(WidgetRegistryService).registerPluginWidget({
      id: 'spec',
      title: 'Spec panel',
      defaultDock: 'left',
      defaultOpen: false,
      defaultFlex: 100,
      mount: () => () => undefined,
    });
    TestBed.tick();
    fixture.detectChanges();
    const button = buttons().find((b) => b.dataset['widget'] === 'spec')!;
    expect(button.textContent?.trim()).toBe('S');
    expect(button.querySelector('svg')).toBeNull();
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('marks the drop slot while a panel drag targets this dock', () => {
    dock.dragging.set('windows');
    dock.dropDock.set('left');
    dock.dropIndex.set(1);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelectorAll('.drop-mark').length).toBe(1);
    expect(host.children[1].classList.contains('drop-mark')).toBe(true);

    dock.dropDock.set('right');
    fixture.detectChanges();
    expect(host.querySelectorAll('.drop-mark').length).toBe(0);
  });
});
