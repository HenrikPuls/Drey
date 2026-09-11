import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DreyApi } from '../../../shared/ipc-api';
import { EditorService } from '../services/editor.service';
import { StatusBar } from './status-bar';

describe('StatusBar', () => {
  let fixture: ComponentFixture<StatusBar>;
  let editor: EditorService;
  let el: HTMLElement;

  beforeEach(async () => {
    window.dreyApi = {
      readVaultFile: () => Promise.resolve({ content: 'one two three', modifiedMs: 1 }),    } as unknown as DreyApi;
    await TestBed.configureTestingModule({ imports: [StatusBar] }).compileComponents();
    editor = TestBed.inject(EditorService);
    fixture = TestBed.createComponent(StatusBar);
    el = fixture.nativeElement as HTMLElement;
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
    localStorage.removeItem('drey.editor');
  });

  it('shows word / char counts for a text document', async () => {
    await editor.openFile('note.md');
    fixture.detectChanges();
    expect(el.textContent).toContain('3 words');
    expect(el.textContent).toContain('13 chars');
  });

  it('shows pixel size + zoom for an image tab', async () => {
    await editor.openFile('shot.png');
    editor.setImageViewport({ naturalWidth: 1024, naturalHeight: 768, scale: 1.5 });
    fixture.detectChanges();

    expect(el.textContent).toContain('1024 × 768 · 150%');
    expect(el.textContent).not.toContain('words');
  });

  it('shows a dash before the image viewport is known', async () => {
    await editor.openFile('shot.png');
    editor.setImageViewport(null);
    fixture.detectChanges();
    expect(el.querySelector('.count')?.textContent?.trim()).toBe('—');
  });
});
