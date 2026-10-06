import { ComponentFixture, TestBed } from '@angular/core/testing';
import { OpenWindows } from './open-windows';
import { EditorService } from '../services/editor.service';
import { VaultService } from '../vault';
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
    await editor.openFile('b.md', undefined, { keepFocused: true });
    fixture.detectChanges();

    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll('.row');
    expect(rows.length).toBe(2);
    (rows[0].querySelector('.open') as HTMLButtonElement).click();
    expect(editor.openPath()).toBe('a.md');
  });

  it('activates a vault-backed tab on click (tab key, not bare path)', async () => {
    // The real app always has an active vault (ADR-0051): the tab key is
    // `v1::a.md` while the row used to hand the bare path to `activate`.
    TestBed.inject(VaultService).activeVaultId.set('v1');
    await editor.openFile('a.md');
    await editor.openFile('b.md', undefined, { keepFocused: true });
    fixture.detectChanges();

    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll('.row');
    expect(editor.openDocs().map((d) => d.key)).toEqual(['v1::a.md', 'v1::b.md']);

    (rows[0].querySelector('.open') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(editor.openPath()).toBe('a.md');
    expect(rows[0].classList.contains('active')).toBe(true);
    expect(rows[1].classList.contains('active')).toBe(false);
  });

  it('closes a tab from the row X', async () => {
    await editor.openFile('a.md');
    await editor.openFile('b.md', undefined, { keepFocused: true });
    fixture.detectChanges();

    const firstClose = (fixture.nativeElement as HTMLElement).querySelector(
      '.row .close',
    ) as HTMLButtonElement;
    firstClose.click();

    expect(editor.openDocs().map((d) => d.path)).toEqual(['b.md']);
  });
});
