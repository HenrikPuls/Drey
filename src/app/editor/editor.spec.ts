import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { vi } from 'vitest';
import { Editor } from './editor';
import { EditorPrefsService } from './editor-prefs.service';
import { EditorService } from '../services/editor.service';
import { EditorZoomService } from '../services/editor-zoom.service';
import { SettingsService } from '../services/settings.service';
import { KeybindingService } from '../keybindings';
import { WikilinkService } from './wikilinks';
import { MarkdownSurface } from './markdown-surface/markdown-surface';
import { DreyApi, NoteSaveRequest } from '../../../shared/ipc-api';
import { normalizeAppConfig } from '../../../shared/app-config';

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

  beforeAll(() => {
    // The caret memory (milestone 50) measures caret positions on leave,
    // and the scroll restore awaits real animation frames -- both make
    // CodeMirror measure / ask for Range layout APIs, which jsdom lacks.
    // Hand them one plausible 10x16 rect so measurements stay sane.
    const rect = {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 10,
      bottom: 16,
      width: 10,
      height: 16,
      toJSON: () => ({}),
    } as DOMRect;
    Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
  });

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
                : relativePath === 'tags.md'
                  ? '# Head\n\ntagged body #sailing\n'
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
    await vi.waitFor(() => expect(saves.some((body) => body.includes('- [x] todo'))).toBe(true));
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

    it('switches to view mode: read-only and never revealing raw markdown', async () => {
      await openRich();
      const menu = openMenu();
      const viewItem = [...menu.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'View',
      ) as HTMLButtonElement;
      viewItem.click();
      fixture.detectChanges();
      await fixture.whenStable();

      expect(editor.viewMode()).toBe('view');
      // The caret sits at the top of the document, yet the heading marks
      // stay concealed (the view mode ignores the selection).
      expect(cmText()).toContain('Doc');
      expect(cmText()).not.toContain('# Doc');
      // Read-only: no editable surface for the user.
      expect(cm().getAttribute('contenteditable')).toBe('false');
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

    it('shows the pinned formatting strip in the meta bar, and it edits the document', async () => {
      // Pinned unless released (req-41).
      const bar = compiled().querySelector('.chrome app-markdown-toolbar') as HTMLElement;
      expect(bar).toBeTruthy();
      expect(bar.querySelector('button[aria-label="Task list"]')).toBeTruthy();

      // Bold with the caret at 0 drops an empty marker pair.
      (bar.querySelector('button[aria-label="Bold"]') as HTMLButtonElement).click();
      fixture.detectChanges();
      await fixture.whenStable();
      expect(cmText()).toContain('****');

      // Blockquote lives in the paragraph-style menu and prefixes the caret's line.
      (bar.querySelector('button[aria-label="Paragraph style"]') as HTMLButtonElement).click();
      fixture.detectChanges();
      const quote = [...bar.querySelectorAll('.menu button')].find(
        (b) => b.textContent?.trim() === 'Blockquote',
      ) as HTMLButtonElement;
      quote.click();
      fixture.detectChanges();
      await fixture.whenStable();
      expect(cmText()).toContain('> ');
      expect(bar.querySelector('.menu')).toBeNull();
    });

    it('the pin releases the strip from the meta bar and persists that', async () => {
      const pin = compiled().querySelector(
        '.chrome app-markdown-toolbar button.pin',
      ) as HTMLButtonElement;
      expect(pin.getAttribute('aria-pressed')).toBe('true');
      expect(pin.getAttribute('aria-label')).toBe('Unpin formatting toolbar');

      pin.click();
      fixture.detectChanges();
      await fixture.whenStable();
      // Released: the bar runs straight into the save cluster.
      expect(compiled().querySelector('app-markdown-toolbar')).toBeNull();
      expect(compiled().querySelector('.chrome .bar-sep')).toBeNull();
      expect(JSON.parse(localStorage.getItem('drey.editor')!).toolbar).toBe(false);

      // Pinning again (the strip's pin in the context menu, the palette
      // command) goes through the same pref.
      TestBed.inject(EditorPrefsService).toggleToolbar();
      fixture.detectChanges();
      await fixture.whenStable();
      expect(compiled().querySelector('app-markdown-toolbar')).toBeTruthy();
      expect(JSON.parse(localStorage.getItem('drey.editor')!).toolbar).toBe(true);
    });

    it('the ⋯ menu no longer carries a toolbar row', () => {
      const menu = openMenu();
      const labels = [...menu.querySelectorAll('button')].map((b) => b.textContent?.trim());
      expect(labels).not.toContain('Formatting toolbar');
    });

    it('renders the toolbar from the persisted pref at startup (vault docKey)', async () => {
      // The real app persists the pref and reopens notes as vault docKeys
      // (`v1::daily/x.md`) after a restart -- the toolbar must survive both.
      localStorage.setItem('drey.editor', JSON.stringify({ toolbar: true }));
      TestBed.resetTestingModule();
      await TestBed.configureTestingModule({ imports: [Editor] }).compileComponents();
      const freshEditor = TestBed.inject(EditorService);
      await freshEditor.openFile('daily/plan.md', 'v1');
      const fresh = TestBed.createComponent(Editor);
      fresh.componentRef.setInput('paneId', 'p1');
      await fresh.whenStable();
      fresh.detectChanges();
      expect(fresh.nativeElement.querySelector('app-markdown-toolbar')).toBeTruthy();
    });
  });

  describe('caret memory (milestone 50)', () => {
    const surfaceView = (fx: ComponentFixture<Editor>) => {
      const surface = fx.debugElement.query(By.directive(MarkdownSurface))
        .componentInstance as MarkdownSurface;
      return surface.view!;
    };
    const settle = async (): Promise<void> => {
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    /** note.md is shown and clean; dirty it so the next open opens ALONGSIDE (ADR-0003). */
    const dirtyNote = (): void => {
      editor.updateBuffer('note.md', '# Title\n\nsome **bold** text with a caret');
    };

    it('restores the caret when switching away and back to an open tab', async () => {
      const view = surfaceView(fixture);
      view.dispatch({ selection: { anchor: 10 } });
      dirtyNote();
      await editor.openFile('rich.md');
      await settle();
      expect(editor.activePath()).toBe('rich.md');

      await editor.openFile('note.md'); // already open -- activates the tab
      await settle();

      expect(view.state.selection.main.head).toBe(10);
    });

    it('an explicit reveal (a link / search hit line) still wins over the caret', async () => {
      const view = surfaceView(fixture);
      view.dispatch({ selection: { anchor: 10 } });
      dirtyNote();
      await editor.openFile('rich.md');
      await settle();

      await editor.openFileAt('note.md', 2);
      await settle();

      expect(view.state.selection.main.head).toBe(view.state.doc.line(2).from);
    });

    it('clamps a stale caret (the buffer shrank) to the document length', async () => {
      dirtyNote();
      await editor.openFile('rich.md');
      await settle();
      editor.recordCaret('note.md', { head: 9999, scrollTop: 0 });

      await editor.openFile('note.md');
      await settle();

      const view = surfaceView(fixture);
      expect(view.state.selection.main.head).toBe(view.state.doc.length);
    });

    /** jsdom has no layout: fixed metrics so the restore's clamp is testable. */
    function mockScroller(view: { scrollDOM: HTMLElement }): HTMLElement {
      const scroller = view.scrollDOM;
      Object.defineProperty(scroller, 'scrollHeight', { value: 2000, configurable: true });
      Object.defineProperty(scroller, 'clientHeight', { value: 400, configurable: true });
      return scroller;
    }

    const nextFrame = (): Promise<void> =>
      new Promise((resolve) => requestAnimationFrame(() => resolve()));

    it('restores the exact scroll offset, not just a visible caret', async () => {
      const view = surfaceView(fixture);
      const scroller = mockScroller(view);
      view.dispatch({ selection: { anchor: 10 } });
      scroller.scrollTop = 400;
      dirtyNote();
      await editor.openFile('rich.md');
      await settle();
      expect(scroller.scrollTop).toBe(0); // the fresh load showed the top

      await editor.openFile('note.md');
      await settle();
      await nextFrame();
      await nextFrame();

      expect(scroller.scrollTop).toBe(400);
      expect(view.state.selection.main.head).toBe(10);
    });

    it('restores the scroll even when the caret never left offset 0', async () => {
      const view = surfaceView(fixture);
      const scroller = mockScroller(view);
      expect(view.state.selection.main.head).toBe(0); // caret untouched
      scroller.scrollTop = 400; // scroll-only browsing
      dirtyNote();
      await editor.openFile('rich.md');
      await settle();

      await editor.openFile('note.md');
      await settle();
      await nextFrame();
      await nextFrame();

      expect(scroller.scrollTop).toBe(400);
      expect(view.state.selection.main.head).toBe(0);
    });

    it('rolls back the browser’s scroll-to-caret after the raw restore', async () => {
      const view = surfaceView(fixture);
      const scroller = mockScroller(view);
      view.dispatch({ selection: { anchor: 10 } });
      scroller.scrollTop = 400;
      dirtyNote();
      await editor.openFile('rich.md');
      await settle();

      await editor.openFile('note.md');
      await settle();
      await nextFrame(); // frame 1: the raw restore lands
      // The focused editor makes the browser scroll the caret into view --
      // AFTER frame 1, exactly the production interference.
      scroller.scrollTop = 26;
      await nextFrame(); // frame 2: the re-assert must win

      expect(scroller.scrollTop).toBe(400);
      expect(view.state.selection.main.head).toBe(10);
    });

    it('corrects the raw offset against the caret’s rendered position (estimates cancel out)', async () => {
      const view = surfaceView(fixture);
      const scroller = mockScroller(view);
      // Capture: the caret sat 100px into the viewport. Restore: the raw
      // offset leaves it at 70px -- the correction must scroll by the
      // delta (400 -> 370), not keep the raw 400. This is the mechanism
      // that absorbs CodeMirror's fresh-state height ESTIMATES.
      const coords = vi
        .spyOn(view, 'coordsAtPos')
        .mockReturnValueOnce({ top: 100, bottom: 116, left: 0, right: 10 })
        .mockReturnValue({ top: 70, bottom: 86, left: 0, right: 10 });
      view.dispatch({ selection: { anchor: 10 } });
      scroller.scrollTop = 400;
      dirtyNote();
      await editor.openFile('rich.md');
      await settle();

      await editor.openFile('note.md');
      await settle();
      await nextFrame();
      await nextFrame();

      expect(scroller.scrollTop).toBe(370);
      expect(view.state.selection.main.head).toBe(10);
      coords.mockRestore();
    });

    it('a reveal cancels the scroll restore -- the target line wins', async () => {
      const view = surfaceView(fixture);
      const scroller = mockScroller(view);
      view.dispatch({ selection: { anchor: 10 } });
      scroller.scrollTop = 400;
      dirtyNote();
      await editor.openFile('rich.md');
      await settle();

      await editor.openFileAt('note.md', 2);
      await settle();
      await nextFrame();

      // The remembered offset never lands: the reveal is the whole jump.
      expect(scroller.scrollTop).not.toBe(400);
      expect(view.state.selection.main.head).toBe(view.state.doc.line(2).from);
    });

    it('keeps the caret for a CLEAN tab that was replaced and reopened', async () => {
      const view = surfaceView(fixture);
      view.dispatch({ selection: { anchor: 10 } });
      // note.md stays clean -- rich.md REPLACES its tab instead of opening
      // alongside (milestone 32). The caret memory must outlive that.
      await editor.openFile('rich.md');
      await settle();
      expect(editor.docFor('note.md')).toBeNull();

      await editor.openFile('note.md'); // fresh open -- caret from the session memory
      await settle();

      expect(view.state.selection.main.head).toBe(10);
    });

    it('focuses the editor when switching back, so typing lands in the document', async () => {
      const view = surfaceView(fixture);
      view.dispatch({ selection: { anchor: 10 } });
      dirtyNote();
      await editor.openFile('rich.md');
      await settle();

      await editor.openFile('note.md'); // activates the tab -- no click into the editor
      await settle();

      const cmEl = cm();
      expect(cmEl.contains(document.activeElement)).toBe(true);
      expect(view.state.selection.main.head).toBe(10);
    });

    it('records the caret when the pane is destroyed, so a remount restores it', async () => {
      const view = surfaceView(fixture);
      view.dispatch({ selection: { anchor: 12 } });
      fixture.destroy();

      const second = TestBed.createComponent(Editor);
      second.componentRef.setInput('paneId', 'p1');
      await second.whenStable();
      second.detectChanges();

      expect(surfaceView(second).state.selection.main.head).toBe(12);
    });

    it('an in-place save reload (the frontmatter bump) keeps the viewport', async () => {
      const view = surfaceView(fixture);
      const scroller = mockScroller(view);
      view.dispatch({ selection: { anchor: 10 } });
      scroller.scrollTop = 400;
      // The save pipeline rewrites the body (every save of a frontmattered
      // note bumps `updated:`) -- the renderer adopts the bump, and the
      // effect reloads the SAME tab in place. The full replace must not
      // cost the user their viewport.
      window.dreyApi = {
        ...window.dreyApi,
        saveNote: (request: NoteSaveRequest) =>
          Promise.resolve({
            path: request.path,
            content: `---\nupdated: 2026-10-09T16:00:00\n---\n${request.body}`,
            modifiedMs: 3,
          }),
      } as DreyApi;
      editor.updateBuffer('note.md', '# Title\n\nsome **bold** text with a caret');
      await editor.save();
      await settle();
      await nextFrame();
      await nextFrame();

      expect(view.state.doc.toString()).toContain('updated: 2026-10-09'); // the bump landed
      expect(view.state.selection.main.head).toBe(10);
      expect(scroller.scrollTop).toBe(400);
    });

    it('a pinned-bottom save keeps following the tail instead of restoring', async () => {
      const view = surfaceView(fixture);
      const scroller = mockScroller(view); // 2000 tall, 400 visible -> bottom is 1600
      view.dispatch({ selection: { anchor: 10 } });
      scroller.scrollTop = 1600; // pinned at the bottom
      window.dreyApi = {
        ...window.dreyApi,
        saveNote: (request: NoteSaveRequest) =>
          Promise.resolve({
            path: request.path,
            content: `---\nupdated: 2026-10-09T16:00:00\n---\n${request.body}`,
            modifiedMs: 3,
          }),
      } as DreyApi;
      editor.updateBuffer('note.md', '# Title\n\nsome **bold** text with a caret');
      await editor.save();
      await settle();
      await nextFrame();
      await nextFrame();

      // Stick-to-bottom is the right destination here -- the restore chain
      // must stay out of the way (the streamed search summary rides this).
      expect(scroller.scrollTop).toBe(scroller.scrollHeight);
      expect(view.state.selection.main.head).toBe(10);
    });
  });

  it('keeps the document intact across mode swaps', async () => {
    editor.setViewMode('source');
    fixture.detectChanges();
    editor.setViewMode('live');
    fixture.detectChanges();
    editor.setViewMode('view');
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

  describe('Suggest tags (req-36)', () => {
    const menuRow = (): HTMLButtonElement => {
      const more = compiled().querySelector('.more') as HTMLButtonElement;
      more.click();
      fixture.detectChanges();
      const row = [...compiled().querySelectorAll('.editor-menu [role="menuitem"]')].find(
        (el) => el.textContent?.trim() === 'Suggest tags',
      );
      expect(row).toBeTruthy();
      return row as HTMLButtonElement;
    };

    const settle = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await fixture.whenStable();
      fixture.detectChanges();
    };

    it('appends the suggested tags to the caret section, deduped, and saves', async () => {
      const saves: string[] = [];
      let sentText = '';
      window.dreyApi = {
        ...window.dreyApi,
        suggestTags: (entryText: string) => {
          sentText = entryText;
          return Promise.resolve(['sailing', 'outdoors']);
        },
        saveNote: (request: NoteSaveRequest) => {
          saves.push(request.body);
          return Promise.resolve({ path: request.path, content: request.body, modifiedMs: 2 });
        },
      } as DreyApi;
      await editor.openFile('tags.md');
      fixture.detectChanges();
      await fixture.whenStable();

      menuRow().click();
      await settle();

      // The section text rode the call (heading included, blanks trimmed).
      expect(sentText).toBe('# Head\n\ntagged body #sailing');
      // `#sailing` was already on the section; only the new tag lands.
      expect(editor.bufferContent()).toBe('# Head\n\ntagged body #sailing #outdoors\n');
      expect(saves.some((body) => body.includes('#outdoors'))).toBe(true);
    });

    it('reports it when every suggestion is already on the section', async () => {
      window.dreyApi = {
        ...window.dreyApi,
        suggestTags: () => Promise.resolve(['sailing']),
      } as DreyApi;
      await editor.openFile('tags.md');
      fixture.detectChanges();
      await fixture.whenStable();

      menuRow().click();
      await settle();

      expect(editor.bufferContent()).toBe('# Head\n\ntagged body #sailing\n');
      expect(compiled().querySelector('.err')?.textContent).toContain('already carries');
    });
  });
});

describe('Editor chrome (meta bar)', () => {
  /**
   * The meta bar's right cluster: dirty state shows in the save button
   * alone (no spelled-out word), and the zoom indicator (Ctrl +/-/0,
   * Ctrl+wheel) appears only away from 100% -- one click resets it.
   * This describe needs a config-serving API so `SettingsService` holds
   * a real config; the main describe's fake has no config methods, which
   * leaves the zoom multiplier pinned at its fallback.
   */
  let fixture: ComponentFixture<Editor>;
  let editor: EditorService;
  let zoom: EditorZoomService;

  beforeEach(async () => {
    const fakeApi: Partial<DreyApi> = {
      getConfig: () => Promise.resolve(normalizeAppConfig({})),
      setConfig: (config) => Promise.resolve(config),
      readVaultFile: () =>
        Promise.resolve({ content: '# Title\n\nsome **bold** text', modifiedMs: 1 }),
      writeVaultFile: () => Promise.resolve(2),
      saveNote: (request) =>
        Promise.resolve({ path: request.path, content: request.body, modifiedMs: 2 }),
    };
    window.dreyApi = fakeApi as DreyApi;

    await TestBed.configureTestingModule({ imports: [Editor] }).compileComponents();
    await TestBed.inject(SettingsService).load(); // a config must be in before zooming
    editor = TestBed.inject(EditorService);
    await editor.openFile('note.md');
    zoom = TestBed.inject(EditorZoomService);

    fixture = TestBed.createComponent(Editor);
    fixture.componentRef.setInput('paneId', 'p1');
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
    localStorage.removeItem('drey.editor');
  });

  const compiled = () => fixture.nativeElement as HTMLElement;

  it('dirty state lives in the save button alone -- no spelled-out "Unsaved"', () => {
    const save = compiled().querySelector('.actions .save') as HTMLButtonElement;
    expect(save.classList.contains('dirty')).toBe(false);
    expect(compiled().querySelector('.unsaved')).toBeNull();

    editor.updateBuffer('note.md', '# Title\n\nsome **bold** text edited');
    fixture.detectChanges();

    expect(save.classList.contains('dirty')).toBe(true);
    expect(compiled().querySelector('.unsaved')).toBeNull();
  });

  it('the zoom chip appears only away from 100%, and a click resets', () => {
    expect(compiled().querySelector('.zoom-chip')).toBeNull();

    zoom.stepIn();
    zoom.stepIn();
    fixture.detectChanges();

    const chip = compiled().querySelector('.zoom-chip') as HTMLButtonElement;
    expect(chip.textContent?.trim()).toBe('120%');

    chip.click();
    fixture.detectChanges();
    expect(compiled().querySelector('.zoom-chip')).toBeNull();
  });
});
