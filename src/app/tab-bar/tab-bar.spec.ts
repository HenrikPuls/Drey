import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TabBar } from './tab-bar';
import { EditorService } from '../services/editor.service';
import { DreyApi } from '../../../shared/ipc-api';

describe('TabBar', () => {
  let fixture: ComponentFixture<TabBar>;
  let editor: EditorService;

  beforeEach(async () => {
    const fakeApi: Partial<DreyApi> = {
      readVaultFile: (p: string) => Promise.resolve({ content: `body of ${p}`, modifiedMs: 1 }),
      writeVaultFile: () => Promise.resolve(2),
    };
    window.dreyApi = fakeApi as DreyApi;

    await TestBed.configureTestingModule({ imports: [TabBar] }).compileComponents();
    editor = TestBed.inject(EditorService);
    await editor.openFile('a.md');
    await editor.openFile('b.md');

    fixture = TestBed.createComponent(TabBar);
    fixture.detectChanges();
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  it('shows one tab per open document, highlighting the active one', () => {
    const tabs = (fixture.nativeElement as HTMLElement).querySelectorAll('.tab');
    expect(Array.from(tabs).map((t) => t.querySelector('.name')?.textContent)).toEqual([
      'a.md',
      'b.md',
    ]);
    expect(tabs[1].classList.contains('active')).toBe(true);
  });

  it('activates a tab on click and closes one via its X', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    (compiled.querySelectorAll('.tab')[0] as HTMLElement).click();
    fixture.detectChanges();
    expect(editor.openPath()).toBe('a.md');

    (compiled.querySelectorAll('.tab .close')[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(editor.openDocs().map((d) => d.path)).toEqual(['a.md']);
  });
});
