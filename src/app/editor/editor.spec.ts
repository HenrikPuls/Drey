import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { Editor } from './editor';
import { EditorService } from '../services/editor.service';
import { KeybindingService } from '../keybindings';
import { WikilinkService } from './wikilinks';
import { DreyApi, NoteSaveRequest } from '../../../shared/ipc-api';

const RICH = [
  '# Doc',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  '- [ ] todo',
  '- [x] done',
  '',
  'Body with **bold** text.',
  '',
  '```ts',
  'const answer: number = 42;',
  '```',
  '',
].join('\n');

const WIKI = 'See [[Plan]] and [[daily/todo|the list]] now.\n';

describe('Editor', () => {
  let fixture: ComponentFixture<Editor>;
  let editor: EditorService;

  beforeEach(async () => {
    const fakeApi: Partial<DreyApi> = {
      readVaultFile: (relativePath: string) => {
        const content =
          relativePath === 'fm.md'
            ? '---\ntype: notiz\n---\n\n# Real heading\n'
            : relativePath === 'rich.md'
              ? RICH
              : relativePath === 'wiki.md'
                ? WIKI
                : '# Title\n\nsome **bold** text';
        return Promise.resolve({ content, modifiedMs: 1 });
      },
      writeVaultFile: () => Promise.resolve(2),
      saveNote: (request) =>
        Promise.resolve({
          path: request.path,
          content: request.body,
          modifiedMs: 2,
        }),
    };
    window.dreyApi = fakeApi as DreyApi;

    await TestBed.configureTestingModule({ imports: [Editor] }).compileComponents();

    editor = TestBed.inject(EditorService);
    await editor.openFile('note.md');

    fixture = TestBed.createComponent(Editor);
    // The single pane `PaneService` starts with -- `EditorService.openFile`
    // above already put `note.md` there (whichever pane is focused).
    fixture.componentRef.setInput('paneId', 'p1');
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
    localStorage.removeItem('drey.editor');
  });

  const compiled = () => fixture.nativeElement as HTMLElement;
  const cm = () => compiled().querySelector('.cm-content') as HTMLElement;
  const cmText = () => cm()?.textContent ?? '';

  async function openRich(): Promise<void> {
    await editor.openFile('rich.md');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('mounts one CodeMirror instance for the open file', () => {
    expect(compiled().querySelector('.cm-editor')).toBeTruthy();
    expect(cmText()).toContain('some');
  });

  it('drives the editor content zoom via a --drey-editor-scale custom property on the host', () => {
    // Default scale with no persisted config is 1; the CSS var must still
    // be bound so `editor-theme.ts`'s calc() has a value.
    expect(compiled().style.getPropertyValue('--drey-editor-scale')).toBe('1');
  });

  it('lands in live preview: text is rendered, syntax markers are concealed', () => {
    // The cursor sits at 0 (on the heading line), so `# ` stays revealed --
    // but the `**` around bold further down must be concealed.
    expect(editor.viewMode()).toBe('live');
    expect(cmText()).toContain('bold');
    expect(cmText()).not.toContain('**');
  });

  it('renders tables as widgets and task markers as real checkboxes', async () => {
    await openRich();

    expect(cm().querySelector('.lp-table table')).toBeTruthy();
    expect(cm().querySelector('.lp-table td')?.textContent).toBe('1');
    expect(cm().querySelector('.lp-table .lp-edit')).toBeTruthy();
    expect(cm().querySelectorAll('.lp-task input')).toHaveLength(2);
    expect(cmText()).not.toContain('| a |');
  });

  it('styles fenced code as a block and conceals the fences', async () => {
    await openRich();

    expect(cm().querySelector('.lp-code')).toBeTruthy();
    expect(cmText()).toContain('const answer: number = 42;');
    expect(cmText()).not.toContain('```');
  });

  it('clicking a checkbox toggles the marker AND saves the note', async () => {
    const saves: string[] = [];
    window.dreyApi = {
      ...window.dreyApi,
      saveNote: (request: NoteSaveRequest) => {
        saves.push(request.body);
        return Promise.resolve({ path: request.path, content: request.body, modifiedMs: 2 });
      },
    } as DreyApi;
    await openRich();

    const box = cm().querySelector('.lp-task input') as HTMLInputElement;
    expect(box).toBeTruthy();
    box.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    fixture.detectChanges();

    expect(editor.bufferContent()).toContain('- [x] todo');
    // The click is the same explicit done-gesture as the Tasks panel's row
    // toggle: the surface saves it (deferred out of the CM update stack),
    // so the vault-scope consumers see it.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fixture.whenStable();
    expect(saves.some((body) => body.includes('- [x] todo'))).toBe(true);
  });

  it('folds frontmatter behind a pill, expandable on click', async () => {
    await editor.openFile('fm.md');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const pill = cm().querySelector('.cm-fm-pill') as HTMLButtonElement;
    expect(pill).toBeTruthy();
    expect(pill.textContent).toContain('Frontmatter');
    expect(pill.textContent).not.toContain('field');
    expect(cmText()).not.toContain('type: notiz');
    expect(cmText()).toContain('Real heading');

    pill.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(cm().querySelector('.cm-fm-pill')).toBeNull();
    expect(cm().querySelector('.cm-fm-line')).toBeTruthy();
    expect(cmText()).toContain('type: notiz');
  });

  it('shows a dirty marker once the buffer diverges from disk', () => {
    editor.updateBuffer('note.md', '# Title\n\nedited');
    fixture.detectChanges();
    expect(compiled().querySelector('.dirty')).toBeTruthy();
  });

  describe('meta-bar icon buttons (req: Lines/Save as icons)', () => {
    it('renders the Lines button icon-only with its toggle label', () => {
      const lines = compiled().querySelector('.lines') as HTMLButtonElement;
      expect(lines.querySelector('svg')).toBeTruthy();
      expect(lines.textContent?.trim()).toBe('');
      expect(lines.getAttribute('aria-label')).toBe('Toggle line numbers');
    });

    it('renders the Save button icon-only, state carried by aria-label/title', () => {
      const save = compiled().querySelector('.save') as HTMLButtonElement;
      expect(save.querySelector('svg')).toBeTruthy();
      expect(save.textContent?.trim()).toBe('');
      expect(save.getAttribute('aria-label')).toBe('Saved');
      expect(save.getAttribute('title')).toBe('Saved');

      editor.updateBuffer('note.md', '# Title\n\nedited');
      fixture.detectChanges();
      expect(save.getAttribute('aria-label')).toBe('Save');
      expect(save.getAttribute('title')).toBe('Save');
    });
  });

  describe('wikilinks (req-20)', () => {
    async function openWiki(): Promise<void> {
      await editor.openFile('wiki.md');
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    }

    it('renders [[links]] as marked spans carrying target and alias', async () => {
      await openWiki();

      const links = [...cm().querySelectorAll('.cm-wikilink')];
      expect(links).toHaveLength(2);
      expect(links[0].getAttribute('data-wikilink')).toBe('Plan');
      expect(links[1].getAttribute('data-wikilink')).toBe('daily/todo');
      expect(links[1].getAttribute('data-alias')).toBe('the list');
    });

    it('Ctrl+click activates the wikilink through the service', async () => {
      await openWiki();
      const wiki = TestBed.inject(WikilinkService);
      const spy = vi.spyOn(wiki, 'open');

      const el = cm().querySelector('.cm-wikilink') as HTMLElement;
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ctrlKey: true }));
      fixture.detectChanges();

      expect(spy).toHaveBeenCalledWith('Plan', null, null, 'wiki.md');
    });

    it('a plain click does not activate', async () => {
      await openWiki();
      const wiki = TestBed.inject(WikilinkService);
      const spy = vi.spyOn(wiki, 'open');

      const el = cm().querySelector('.cm-wikilink') as HTMLElement;
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      fixture.detectChanges();

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('the ⋯ mode menu', () => {
    function openMenu(): HTMLElement {
      (compiled().querySelector('.more') as HTMLButtonElement).click();
      fixture.detectChanges();
      return compiled().querySelector('.editor-menu') as HTMLElement;
    }

    it('switches to source mode, showing the raw markdown', async () => {
      const menu = openMenu();
      const sourceItem = [...menu.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'Source',
      ) as HTMLButtonElement;
      sourceItem.click();
      fixture.detectChanges();
      await fixture.whenStable();

      expect(editor.viewMode()).toBe('source');
      expect(cmText()).toContain('**bold**');
    });

    it('marks the active mode with a check', () => {
      const menu = openMenu();
      const checked = menu.querySelector('button[aria-checked="true"]') as HTMLElement;
      expect(checked.textContent?.trim()).toBe('Live Preview');
      expect(checked.querySelector('app-icon')).toBeTruthy();
    });

    it('closes after a choice', () => {
      const menu = openMenu();
      (menu.querySelector('button') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(compiled().querySelector('.editor-menu')).toBeNull();
    });
  });

  it('keeps the document intact across mode swaps', async () => {
    editor.setViewMode('source');
    fixture.detectChanges();
    editor.setViewMode('live');
    fixture.detectChanges();
    editor.setViewMode('source');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(cmText()).toContain('# Title');
    expect(cmText()).toContain('**bold**');
  });

  it('the app-wide save command saves and leaves the mode unchanged', async () => {
    // Ctrl+S is registered by `App` on the keybinding registry now, not by
    // the editor host -- wire the same command here and fire the chord.
    const keys = TestBed.inject(KeybindingService);
    let savePromise: Promise<void> = Promise.resolve();
    keys.register({
      id: 'note.save',
      label: 'Save',
      keybinding: 'Mod+S',
      run: () => {
        savePromise = editor.save();
      },
    });

    editor.updateBuffer('note.md', '# Title\n\nsome **bold** text edited');
    fixture.detectChanges();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
    await savePromise; // the save is serialized now -- await it explicitly
    await fixture.whenStable();
    fixture.detectChanges();

    expect(editor.isDirty()).toBe(false);
    expect(editor.viewMode()).toBe('live');
  });

  it('starts a new timestamped entry on a quick-capture request', async () => {
    editor.setViewMode('source');
    editor.requestNewDailyEntry();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(cmText()).toMatch(/## \d{2}:\d{2}/);
    expect(editor.isDirty()).toBe(true);
  });

  it('inserts capture-input text under a fresh timestamp heading', async () => {
    editor.setViewMode('source');
    editor.requestNewDailyEntry('- [ ] call the marina #sailing');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(editor.bufferContent()).toMatch(/\n## \d{2}:\d{2}\n- \[ \] call the marina #sailing\n$/);
    expect(editor.isDirty()).toBe(true);
  });

  describe('stale request claims (files stay untouched without a user edit)', () => {
    /**
     * Consumes a request in the mounted editor, then simulates opening
     * another file -- which remounts `app-editor` in a real pane -- and
     * asserts the fresh instance does NOT re-apply the consumed request
     * (the stale `## HH:mm` bug).
     */
    async function remountOnOtherFile(): Promise<void> {
      await editor.openFile('rich.md');
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.destroy();

      const second = TestBed.createComponent(Editor);
      second.componentRef.setInput('paneId', 'p1');
      await second.whenStable();
      second.detectChanges();
    }

    it('a consumed quick-capture request never reaches a freshly mounted editor', async () => {
      editor.requestNewDailyEntry();
      fixture.detectChanges();
      await fixture.whenStable();
      expect(editor.bufferContent()).toMatch(/## \d{2}:\d{2}/);

      await remountOnOtherFile();

      expect(editor.activePath()).toBe('rich.md');
      expect(editor.bufferContent()).toBe(RICH);
      expect(editor.isDirty()).toBe(false);
    });

    it('a consumed insert request never reaches a freshly mounted editor', async () => {
      editor.requestInsertText('hello');
      fixture.detectChanges();
      await fixture.whenStable();
      expect(editor.bufferContent()).toContain('hello');

      await remountOnOtherFile();

      expect(editor.activePath()).toBe('rich.md');
      expect(editor.bufferContent()).toBe(RICH);
    });
  });
});
