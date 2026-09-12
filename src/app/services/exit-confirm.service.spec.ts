import { TestBed } from '@angular/core/testing';
import {
  DreyApi,
  ExitConfirmRequest,
  ExitDecision,
  NoteSaveRequest,
} from '../../../shared/ipc-api';
import { EditorService } from './editor.service';
import { ExitConfirmService } from './exit-confirm.service';

/**
 * Harness for the save-before-exit bridge (bug-5): a real `EditorService`
 * (fake `window.dreyApi`), the real `ExitConfirmService`, and the captured
 * `onExitConfirmRequest` listener so the test plays main's part.
 */
describe('ExitConfirmService', () => {
  let service: ExitConfirmService;
  let editor: EditorService;
  let exitListener: ((request: ExitConfirmRequest) => void) | undefined;
  let decisions: ExitDecision[];
  let saves: NoteSaveRequest[];
  let draftSaves: Array<{ body: string; eol: string }>;

  function request(id: number): void {
    exitListener?.({ id });
  }

  beforeEach(() => {
    exitListener = undefined;
    decisions = [];
    saves = [];
    draftSaves = [];
    window.dreyApi = {
      onExitConfirmRequest: (listener: (request: ExitConfirmRequest) => void) => {
        exitListener = listener;
        return () => undefined;
      },
      resolveExitConfirm: (id: number, decision: ExitDecision) => {
        decisions.push(decision);
        return Promise.resolve();
      },
      readVaultFile: (relativePath: string) =>
        Promise.resolve({ content: `content of ${relativePath}`, modifiedMs: 100 }),
      saveNote: (req: NoteSaveRequest) => {
        saves.push(req);
        return Promise.resolve({ path: req.path, content: req.body, modifiedMs: 200 });
      },
      saveDraftNote: (req: { body: string; eol?: string }) => {
        draftSaves.push({ body: req.body, eol: req.eol ?? '\n' });
        return Promise.resolve({
          path: `.drafts/unnamed-${draftSaves.length}.md`,
          content: req.body,
          modifiedMs: 300,
        });
      },
      writeSessionBackup: () => Promise.resolve(),
      deleteSessionBackups: () => Promise.resolve(),
    } as unknown as DreyApi;
    service = TestBed.inject(ExitConfirmService);
    editor = TestBed.inject(EditorService);
    service.start();
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
    localStorage.removeItem('drey.editor');
  });

  it('answers a clean state immediately with "discard" and shows no dialog', async () => {
    await editor.openFile('note.md');

    request(1);
    await Promise.resolve();

    expect(decisions).toEqual(['discard']);
    expect(service.pending()).toBeNull();
  });

  it('shows the dialog when documents are dirty; Cancel answers "cancel"', async () => {
    await editor.openFile('note.md');
    editor.updateBuffer('note.md', 'an edit');

    request(1);

    expect(service.pending()).toBe(1);
    await service.choose('cancel');
    expect(decisions).toEqual(['cancel']);
    expect(service.pending()).toBe(null);
  });

  it('Save all writes real files without on-save actions and commits scratch tabs as drafts', async () => {
    await editor.openFile('note.md');
    editor.updateBuffer('note.md', 'an edit');
    editor.openScratch('untitled.md', 'search export');

    request(1);
    expect(service.pending()).toBe(1);

    await service.choose('save');

    expect(saves).toEqual([
      { path: 'note.md', body: 'an edit', eol: '\n', runOnSaveActions: false },
    ]);
    expect(draftSaves).toEqual([{ body: 'search export', eol: '\n' }]);
    // The scratch tab is re-keyed to its drafts path and clean.
    const draft = editor.docFor('.drafts/unnamed-1.md');
    expect(draft?.existsOnDisk).toBe(true);
    expect(draft?.askOnSave).toBe(false);
    expect(draft?.savedContent).toBe('search export');
    expect(decisions).toEqual(['save']);
    expect(service.pending()).toBe(null);
  });

  it('a failed save keeps the app open (answers "cancel")', async () => {
    await editor.openFile('note.md');
    editor.updateBuffer('note.md', 'an edit');
    (window.dreyApi as Partial<DreyApi>).saveNote = () => Promise.reject(new Error('disk full'));

    request(1);
    expect(service.pending()).toBe(1);

    await service.choose('save');
    expect(decisions).toEqual(['cancel']);
    expect(service.pending()).toBe(null);
    expect(editor.isDirty()).toBe(true);
  });

  it('Exit without saving answers "discard"', async () => {
    await editor.openFile('note.md');
    editor.updateBuffer('note.md', 'an edit');

    request(1);
    expect(service.pending()).toBe(1);

    await service.choose('discard');
    expect(decisions).toEqual(['discard']);
    expect(service.pending()).toBe(null);
  });
});
