import { ComponentFixture, TestBed } from '@angular/core/testing';
import { OpenWindows } from './open-windows';
import { EditorService } from '../services/editor.service';
import { DreyApi } from '../../../shared/ipc-api';

describe('OpenWindows', () => {
  let fixture: ComponentFixture<OpenWindows>;
  let editor: EditorService;

  beforeEach(async () => {
    const fakeApi: Partial<DreyApi> = {
      readVaultFile: (p: string) => Promise.resolve({ content: `body of ${p}`, modifiedMs: 1 }),
    };
    window.dreyApi = fakeApi as DreyApi;

    await TestBed.configureTestingModule({ imports: [OpenWindows] }).compileComponents();
    editor = TestBed.inject(EditorService);
    fixture = TestBed.createComponent(OpenWindows);
    fixture.detectChanges();
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  it('shows an empty hint with nothing open', () => {
    expect((fixture.nativeElement as HTMLElement).querySelector('.empty')).toBeTruthy();
  });

  it('lists open docs and activates one on click', async () => {
    await editor.openFile('a.md');
    await editor.openFile('b.md');
    fixture.detectChanges();

    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll('.row');
    expect(rows.length).toBe(2);
    (rows[0].querySelector('.open') as HTMLButtonElement).click();
    expect(editor.openPath()).toBe('a.md');
  });

  it('closes a tab from the row X', async () => {
    await editor.openFile('a.md');
    await editor.openFile('b.md');
    fixture.detectChanges();

    const firstClose = (fixture.nativeElement as HTMLElement).querySelector(
      '.row .close',
    ) as HTMLButtonElement;
    firstClose.click();

    expect(editor.openDocs().map((d) => d.path)).toEqual(['b.md']);
  });
});
