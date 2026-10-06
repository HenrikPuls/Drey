import { ComponentFixture, TestBed } from '@angular/core/testing';
import type { EditorView } from '@codemirror/view';
import { EntryDrawer } from './entry-drawer';
import { slashCommandSource } from '../editor/slash-commands';
import { EditTargetService } from '../services/edit-target.service';
import { DreyApi } from '../../../shared/ipc-api';

/**
 * The drawer's formatting-toolbar toggle (own persisted pref) and the
 * `/` dialog being live on the drawer's surface. Mirrors the editor
 * toolbar tests in `editor.spec.ts`.
 */
describe('EntryDrawer', () => {
  let fixture: ComponentFixture<EntryDrawer>;

  beforeEach(async () => {
    const fakeApi: Partial<DreyApi> = {
      readVaultFile: () => Promise.resolve({ content: '', modifiedMs: 1 }),
      writeVaultFile: () => Promise.resolve(2),
      saveNote: (request) =>
        Promise.resolve({ path: request.path, content: request.body, modifiedMs: 2 }),
    };
    window.dreyApi = fakeApi as DreyApi;

    await TestBed.configureTestingModule({ imports: [EntryDrawer] }).compileComponents();
    fixture = TestBed.createComponent(EntryDrawer);
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
    localStorage.removeItem('drey.editor');
  });

  const compiled = () => fixture.nativeElement as HTMLElement;

  /** The drawer surface's live view, via the focus-tracking service. */
  function drawerView(): EditorView | null {
    (compiled().querySelector('.cm-content') as HTMLElement).focus();
    return TestBed.inject(EditTargetService).view;
  }

  describe('formatting toolbar toggle', () => {
    it('is hidden by default, the symbol toggles it on and persists it', async () => {
      expect(compiled().querySelector('.md-editor app-markdown-toolbar')).toBeNull();

      const toggle = compiled().querySelector<HTMLButtonElement>('.tb-toggle');
      expect(toggle?.getAttribute('aria-pressed')).toBe('false');
      toggle!.click();
      fixture.detectChanges();
      await fixture.whenStable();

      expect(compiled().querySelector('.md-editor app-markdown-toolbar')).toBeTruthy();
      expect(JSON.parse(localStorage.getItem('drey.editor')!).entryToolbar).toBe(true);
    });

    it('toggles back off and persists that too', async () => {
      const toggle = compiled().querySelector<HTMLButtonElement>('.tb-toggle')!;
      toggle.click();
      fixture.detectChanges();
      await fixture.whenStable();
      toggle.click();
      fixture.detectChanges();
      await fixture.whenStable();

      expect(compiled().querySelector('.md-editor app-markdown-toolbar')).toBeNull();
      expect(JSON.parse(localStorage.getItem('drey.editor')!).entryToolbar).toBe(false);
    });

    it('renders the toolbar from the persisted pref at startup', async () => {
      localStorage.setItem('drey.editor', JSON.stringify({ entryToolbar: true }));
      TestBed.resetTestingModule();
      await TestBed.configureTestingModule({ imports: [EntryDrawer] }).compileComponents();
      const fresh = TestBed.createComponent(EntryDrawer);
      await fresh.whenStable();
      fresh.detectChanges();
      expect(fresh.nativeElement.querySelector('.md-editor app-markdown-toolbar')).toBeTruthy();
    });

    it('a toolbar button edits the drawer body', async () => {
      compiled().querySelector<HTMLButtonElement>('.tb-toggle')!.click();
      fixture.detectChanges();
      await fixture.whenStable();

      const bold = compiled().querySelector(
        '.md-editor button[aria-label="Bold"]',
      ) as HTMLButtonElement;
      bold.click();
      fixture.detectChanges();
      await fixture.whenStable();

      const text = compiled().querySelector('.cm-content')?.textContent ?? '';
      expect(text).toContain('****');
    });
  });

  describe('slash dialog', () => {
    // The drawer turns `submitOnEnter` off, so the gate in
    // `markdown-surface.ts` keeps the source mounted on its surface.
    it('has the slash-command source registered on the drawer editor', () => {
      const view = drawerView();
      expect(view).toBeTruthy();
      const sources = view!.state.languageDataAt('autocomplete', 0);
      expect(sources).toContain(slashCommandSource);
    });
  });
});
