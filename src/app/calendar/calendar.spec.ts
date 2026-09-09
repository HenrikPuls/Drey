import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Calendar } from './calendar';
import { CalendarService } from './calendar.service';
import { EditorService } from '../services/editor.service';
import { DreyApi } from '../../../shared/ipc-api';

describe('Calendar', () => {
  let fixture: ComponentFixture<Calendar>;
  let cal: CalendarService;
  let editor: EditorService;

  beforeEach(async () => {
    const fakeApi: Partial<DreyApi> = {
      getActiveVault: () => Promise.resolve('E:/vault'),
      listVaultFiles: () => Promise.resolve([]),
      readVaultFile: () => Promise.reject(new Error('ENOENT')),
      buildDailyNoteContent: () => Promise.resolve('# draft\n'),
    };
    window.dreyApi = fakeApi as DreyApi;

    await TestBed.configureTestingModule({ imports: [Calendar] }).compileComponents();
    fixture = TestBed.createComponent(Calendar);
    cal = TestBed.inject(CalendarService);
    editor = TestBed.inject(EditorService);
    fixture.detectChanges();
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  it('renders a 42-cell grid and the month label', () => {
    cal.viewYear.set(2026);
    cal.viewMonth.set(8);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.month')?.textContent).toContain('September 2026');
    expect(compiled.querySelectorAll('.day').length).toBe(42);
  });

  it('selects a day and asks the editor to open that daily note', async () => {
    cal.viewYear.set(2026);
    cal.viewMonth.set(8);
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const cells = Array.from(compiled.querySelectorAll<HTMLButtonElement>('.day'));
    // Row 0 is Aug 31 + Sep 1..6; index 2 is Sep 2.
    cells[2].click();
    await fixture.whenStable();

    expect(cal.selectedIso()).toBe('2026-09-02');
    expect(editor.openPath()).toBe('daily/2026/09/2026-09-02.md');
    expect(editor.activeIsDraft()).toBe(true);
  });

  it('opens the month/year picker from the header and jumps the shown month', () => {
    cal.viewYear.set(2026);
    cal.viewMonth.set(8);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;

    compiled.querySelector<HTMLButtonElement>('.month')!.click();
    fixture.detectChanges();

    // Day grid is replaced by twelve month cells; the header now shows the year.
    expect(compiled.querySelectorAll('.month-cell').length).toBe(12);
    expect(compiled.querySelectorAll('.day').length).toBe(0);
    expect(compiled.querySelector('.month')?.textContent).toContain('2026');

    // While the picker is open the ‹ › buttons step the year, and stepping
    // alone must not move the calendar underneath.
    compiled.querySelector<HTMLButtonElement>('.nav-btn')!.click();
    fixture.detectChanges();
    expect(compiled.querySelector('.month')?.textContent).toContain('2025');
    expect(cal.viewYear()).toBe(2026);

    // Picking a month commits year + month and returns to the day grid.
    const cells = compiled.querySelectorAll<HTMLButtonElement>('.month-cell');
    cells[2].click();
    fixture.detectChanges();
    expect([cal.viewYear(), cal.viewMonth()]).toEqual([2025, 2]);
    expect(compiled.querySelector('.month')?.textContent).toContain('March 2025');
    expect(compiled.querySelectorAll('.day').length).toBe(42);
  });

  it('closes the picker on Escape without changing the shown month', () => {
    cal.viewYear.set(2026);
    cal.viewMonth.set(8);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;

    compiled.querySelector<HTMLButtonElement>('.month')!.click();
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();

    expect(compiled.querySelectorAll('.month-cell').length).toBe(0);
    expect([cal.viewYear(), cal.viewMonth()]).toEqual([2026, 8]);
  });
});
