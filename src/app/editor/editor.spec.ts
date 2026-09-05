import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Editor } from './editor';
import { EditorService } from '../services/editor.service';
import { DreyApi } from '../../../shared/ipc-api';

describe('Editor', () => {
  let fixture: ComponentFixture<Editor>;
  let editor: EditorService;

  beforeEach(async () => {
    const fakeApi: Partial<DreyApi> = {
      readVaultFile: () =>
        Promise.resolve({ content: '# Title\n\nsome **bold** text', modifiedMs: 1 }),
      writeVaultFile: () => Promise.resolve(2),
    };
    window.dreyApi = fakeApi as DreyApi;

    await TestBed.configureTestingModule({ imports: [Editor] }).compileComponents();

    editor = TestBed.inject(EditorService);
    await editor.openFile('note.md');

    fixture = TestBed.createComponent(Editor);
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
    localStorage.removeItem('drey.editor');
  });

  it('mounts a CodeMirror instance for the open file', () => {
    editor.setViewMode('source');
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.cm-editor')).toBeTruthy();
    expect(compiled.querySelector('.cm-content')?.textContent).toContain('some **bold** text');
  });

  it('lands in the rendered view by default and renders markdown to HTML', async () => {
    await fixture.whenStable();

    const rendered = (fixture.nativeElement as HTMLElement).querySelector('.rendered');
    expect(rendered?.querySelector('h1')?.textContent).toBe('Title');
    expect(rendered?.querySelector('strong')?.textContent).toBe('bold');
  });

  it('does not render leading frontmatter in the rendered view', async () => {
    editor.updateBuffer('---\ntype: notiz\ntags: ["daily"]\n---\n\n# Real heading\n');
    fixture.detectChanges();
    await fixture.whenStable();

    const doc = (fixture.nativeElement as HTMLElement).querySelector(
      '.rendered .doc',
    ) as HTMLElement;
    expect(doc.querySelector('h1')?.textContent).toBe('Real heading');
    expect(doc.textContent).not.toContain('type: notiz');
    expect(doc.querySelector('hr')).toBeNull();
  });

  it('shows a dirty marker once the buffer diverges from disk', () => {
    editor.updateBuffer('# Title\n\nedited');
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.dirty')).toBeTruthy();
  });

  describe('auto-switch mode', () => {
    it('keeps the cm-src marker class through Angular sanitization', async () => {
      await fixture.whenStable();
      const doc = (fixture.nativeElement as HTMLElement).querySelector(
        '.rendered .doc',
      ) as HTMLElement;
      // Angular's [innerHTML] sanitizer strips data-* but keeps class.
      expect(doc.querySelector('[class*="cm-src-"]')).toBeTruthy();
    });

    it('maps a caret placed in the preview to the matching buffer offset', async () => {
      // Buffer: "# Title\n\nsome **bold** text" -- offset 16 is the 'b' of **bold**.
      editor.setAutoSwitch(true);
      fixture.detectChanges();
      await fixture.whenStable();

      const doc = (fixture.nativeElement as HTMLElement).querySelector(
        '.rendered .doc',
      ) as HTMLElement;
      const para = doc.querySelector('p.cm-src-1') as HTMLElement;
      const firstText = para.firstChild as Text; // "some "
      const range = document.createRange();
      range.setStart(firstText, 5); // end of "some " -> start of rendered "bold"
      range.collapse(true);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);

      doc.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(editor.caretOffset()).toBe(16);
    });

    it('a click on the preview does not drop to source', async () => {
      editor.setAutoSwitch(true);
      fixture.detectChanges();
      await fixture.whenStable();

      const doc = (fixture.nativeElement as HTMLElement).querySelector(
        '.rendered .doc',
      ) as HTMLElement;
      doc.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      fixture.detectChanges();

      expect(editor.viewMode()).toBe('rendered');
    });

    it('a typed character switches to source and is inserted at the shared caret', async () => {
      editor.setAutoSwitch(true);
      editor.setCaretOffset(0);
      fixture.detectChanges();
      await fixture.whenStable();

      const doc = (fixture.nativeElement as HTMLElement).querySelector(
        '.rendered .doc',
      ) as HTMLElement;
      doc.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: 'X',
        }),
      );
      fixture.detectChanges();
      await fixture.whenStable();

      expect(editor.viewMode()).toBe('source');
      expect(editor.bufferContent().startsWith('X')).toBe(true);
    });

    it('returns to the rendered view after a save from source', async () => {
      editor.setAutoSwitch(true);
      editor.setViewMode('source');
      editor.updateBuffer('# Title\n\nsome **bold** text edited');
      fixture.detectChanges();

      (fixture.nativeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }),
      );
      await fixture.whenStable();
      fixture.detectChanges();

      expect(editor.viewMode()).toBe('rendered');
      expect(editor.isDirty()).toBe(false);
    });
  });

  describe('rendered view with auto-switch off', () => {
    it('a click on the preview does not switch to source', async () => {
      editor.setAutoSwitch(false);
      editor.setViewMode('rendered');
      fixture.detectChanges();
      await fixture.whenStable();

      const doc = (fixture.nativeElement as HTMLElement).querySelector(
        '.rendered .doc',
      ) as HTMLElement;
      doc.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      fixture.detectChanges();

      expect(editor.viewMode()).toBe('rendered');
    });
  });

  it('starts a new timestamped entry on a quick-capture request', async () => {
    editor.setViewMode('source');
    editor.requestNewDailyEntry();
    fixture.detectChanges();
    await fixture.whenStable();

    const text =
      (fixture.nativeElement as HTMLElement).querySelector('.cm-content')?.textContent ?? '';
    expect(text).toMatch(/## \d{2}:\d{2}/);
    expect(editor.isDirty()).toBe(true);
  });
});
