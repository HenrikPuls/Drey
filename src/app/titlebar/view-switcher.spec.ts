import { ComponentFixture, TestBed } from '@angular/core/testing';
import type { DreyApi } from '../../../shared/ipc-api';
import { DockService } from '../dock';
import { ViewService } from '../views';
import { ViewSwitcher } from './view-switcher';

describe('ViewSwitcher', () => {
  let fixture: ComponentFixture<ViewSwitcher>;
  let views: ViewService;
  let dock: DockService;

  const root = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const q = <T extends HTMLElement>(sel: string): T | null => root().querySelector<T>(sel);
  const rows = (): HTMLButtonElement[] => Array.from(root().querySelectorAll<HTMLButtonElement>('.ctx-menu button'));
  const rowByLabel = (label: string): HTMLButtonElement =>
    rows().find((b) => b.textContent?.includes(label)) as HTMLButtonElement;

  beforeEach(async () => {
    localStorage.clear();
    window.dreyApi = {} as unknown as DreyApi;
    await TestBed.configureTestingModule({ imports: [ViewSwitcher] }).compileComponents();
    views = TestBed.inject(ViewService);
    dock = TestBed.inject(DockService);
    views.saveCurrentAs('Review');
    views.switchTo('notes');
    fixture = TestBed.createComponent(ViewSwitcher);
    fixture.detectChanges();
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
    localStorage.clear();
  });

  it('is one segmented control; the loose save and revert icons are gone', () => {
    expect(Array.from(root().querySelectorAll('.vs-btn')).map((b) => b.textContent?.trim())).toEqual(['Notes', 'Review']);
    expect(q('.vs-mod')).toBeNull();
    expect(q('[aria-label="Save view"]')).toBeNull();
    expect(q('[aria-label="Revert view"]')).toBeNull();
    expect(q('.vs-layout')?.getAttribute('aria-label')).toBe('Layout');
  });

  it('marks the view whose layout changed with a dot, and only that one', () => {
    expect(root().querySelectorAll('.vs-dot').length).toBe(0);
    dock.setDockWidth('left', 333);
    fixture.detectChanges();
    const dots = root().querySelectorAll('.vs-dot');
    expect(dots.length).toBe(1);
    expect(dots[0].closest('.vs-btn')?.textContent).toContain('Notes');
  });

  it('shows a dot on a view its plugin flagged (SDK 1.50, board 7h), named for assistive tech', () => {
    views.registerPreset('acme', { id: 'acme.work', label: 'Work' });
    fixture.detectChanges();
    expect(root().querySelectorAll('.vs-dot').length).toBe(0);
    views.setBadge('acme', 'acme.work', true);
    fixture.detectChanges();
    const dot = root().querySelector('.vs-btn .vs-dot[role="img"]');
    expect(dot?.closest('.vs-btn')?.textContent).toContain('Work');
    expect(dot?.getAttribute('aria-label')).toBe('Something needs you in Work');
    views.setBadge('acme', 'acme.work', false);
    fixture.detectChanges();
    expect(root().querySelectorAll('.vs-dot').length).toBe(0);
  });

  it('Layout opens one menu (board 7h): a head line, save, reset, save as new view, rename, delete, a note', () => {
    q<HTMLButtonElement>('.vs-layout')!.click();
    fixture.detectChanges();
    expect(q('.ctx-menu .menu-head')?.textContent?.trim()).toBe('Notes · docks, panels, panes and tabs');
    const labels = rows().map((e) => e.textContent?.trim());
    expect(labels).toEqual(['Save layout', 'Reset to saved layout', 'Save as new view…', 'Rename view…', 'Delete view…']);
    expect(q('.ctx-menu .menu-foot')?.textContent?.trim()).toBe('Deleting asks first. Tabs that only lived in this view close; their files stay.');
    expect(root().querySelectorAll('.ctx-menu .row-desc').length).toBe(0);
  });

  it('Save layout and Reset are disabled until the layout changed; Rename and Delete not on Notes', () => {
    q<HTMLButtonElement>('.vs-layout')!.click();
    fixture.detectChanges();
    expect(rowByLabel('Save layout').disabled).toBe(true);
    expect(rowByLabel('Reset to saved layout').disabled).toBe(true);
    expect(rowByLabel('Rename view…').disabled).toBe(true);
    expect(rowByLabel('Delete view…').disabled).toBe(true);
  });

  it('Save layout keeps the working layout and clears the dot', () => {
    dock.setDockWidth('left', 333);
    fixture.detectChanges();
    q<HTMLButtonElement>('.vs-layout')!.click();
    fixture.detectChanges();
    rowByLabel('Save layout').click();
    fixture.detectChanges();
    expect(views.modified()).toBe(false);
    expect(root().querySelectorAll('.vs-dot').length).toBe(0);
  });

  it('Rename and Delete act on a user view', async () => {
    views.switchTo(views.views()[1].id);
    fixture.detectChanges();
    q<HTMLButtonElement>('.vs-layout')!.click();
    fixture.detectChanges();
    expect(rowByLabel('Rename view…').disabled).toBe(false);
    expect(rowByLabel('Delete view…').classList.contains('danger')).toBe(true);
    rowByLabel('Rename view…').click();
    fixture.detectChanges();
    expect(views.prompt()?.mode).toBe('rename');
    views.cancelPrompt();
    await Promise.resolve();
  });

  it('switching a view never saves it (D-6)', () => {
    dock.setDockWidth('left', 333);
    q<HTMLButtonElement>('.vs-btn:last-child')!.click();
    fixture.detectChanges();
    views.switchTo('notes');
    expect(views.modified()).toBe(true);
  });
});
