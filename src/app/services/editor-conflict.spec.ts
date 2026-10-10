import { TestBed } from '@angular/core/testing';
import { DreyApi, NoteSaveRequest, NoteSaveResult } from '../../../shared/ipc-api';
import { ConflictService } from '../conflict';
import { EditorService } from './editor.service';

/**
 * The save-conflict flow (milestone 60, ADR-0060): what `EditorService`
 * does when main refuses a save because the file changed on disk, and how
 * a dirty tab is marked when the watcher round reports its file.
 */
describe('EditorService save conflicts', () => {
  const KEY = 'v1::a.md';
  let service: EditorService;
  let conflicts: ConflictService;
  let disk: { content: string; modifiedMs: number };
  let saves: NoteSaveRequest[];
  let captured: Array<{ path: string; content: string; origin: string }>;

  beforeEach(() => {
    disk = { content: 'original', modifiedMs: 100 };
    saves = [];
    captured = [];
    const api: Partial<DreyApi> = {
      readVaultFile: () => Promise.resolve({ ...disk }),
      // The fake main: refuses a stale base unless forced, like NoteManager.
      saveNote: (request: NoteSaveRequest): Promise<NoteSaveResult> => {
        saves.push(request);
        if (request.baseModifiedMs !== undefined && request.force !== true && request.baseModifiedMs !== disk.modifiedMs) {
          return Promise.resolve({
            path: request.path,
            content: request.body,
            modifiedMs: request.baseModifiedMs,
            conflict: { ...disk },
          });
        }
        disk = { content: request.body, modifiedMs: disk.modifiedMs + 1 };
        return Promise.resolve({ path: request.path, content: request.body, modifiedMs: disk.modifiedMs });
      },
      captureNoteHistory: (path: string, content: string, origin: string) => {
        captured.push({ path, content, origin });
        return Promise.resolve(true);
      },
    };
    window.dreyApi = api as DreyApi;
    service = TestBed.inject(EditorService);
    conflicts = TestBed.inject(ConflictService);
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
    localStorage.removeItem('drey.editor');
  });

  async function openAndEdit(): Promise<void> {
    await service.openFile('a.md', 'v1');
    service.updateBuffer(KEY, 'my edit');
  }

  /** Answers the merge dialog: one side as it is, a merged text, or cancel. */
  async function answerWhenAsked(choice: 'mine' | 'disk' | 'cancel' | { merged: string }): Promise<void> {
    await vi.waitFor(() => expect(conflicts.pending()).not.toBeNull());
    const pending = conflicts.pending()!;
    conflicts.answer(
      choice === 'cancel'
        ? null
        : choice === 'mine'
          ? pending.mine
          : choice === 'disk'
            ? pending.disk
            : choice.merged,
    );
  }

  it('saves straight through when the file is as the tab last read it', async () => {
    await openAndEdit();
    await service.save({ key: KEY });
    expect(saves).toHaveLength(1);
    expect(saves[0].baseModifiedMs).toBe(100);
    expect(service.docFor(KEY)?.modifiedMs).toBe(101);
  });

  it('a touched but unchanged file is no conflict: retries with force, no dialog', async () => {
    await openAndEdit();
    disk = { content: 'original', modifiedMs: 900 };
    await service.save({ key: KEY });
    expect(conflicts.pending()).toBeNull();
    expect(saves.map((s) => s.force === true)).toEqual([false, true]);
    expect(saves[1].origin).toBeUndefined();
    expect(disk.content).toBe('my edit');
  });

  it('"Keep mine" overwrites and tells the history it was a conflict', async () => {
    await openAndEdit();
    disk = { content: 'theirs', modifiedMs: 900 };
    const done = service.save({ key: KEY });
    await answerWhenAsked('mine');
    await done;
    expect(saves[1]).toMatchObject({ force: true, origin: 'conflict', body: 'my edit' });
    expect(disk.content).toBe('my edit');
    expect(service.docFor(KEY)?.bufferContent).toBe(service.docFor(KEY)?.savedContent);
  });

  it('a merged result becomes the buffer and the file; the buffer as it was is recorded', async () => {
    await openAndEdit();
    disk = { content: 'theirs', modifiedMs: 900 };
    const done = service.save({ key: KEY });
    await vi.waitFor(() => expect(conflicts.pending()).not.toBeNull());
    expect(conflicts.pending()).toMatchObject({ base: 'original', disk: 'theirs', mine: 'my edit' });
    await answerWhenAsked({ merged: 'theirs\nmy edit' });
    await done;
    expect(saves[1]).toMatchObject({ force: true, origin: 'conflict', body: 'theirs\nmy edit' });
    expect(captured).toEqual([{ path: 'a.md', content: 'my edit', origin: 'conflict' }]);
    const doc = service.docFor(KEY);
    expect(doc?.bufferContent).toBe('theirs\nmy edit');
    expect(doc?.savedContent).toBe('theirs\nmy edit');
  });

  it('"Use disk version" records the buffer and loads the file', async () => {
    await openAndEdit();
    disk = { content: 'theirs', modifiedMs: 900 };
    const done = service.save({ key: KEY });
    await answerWhenAsked('disk');
    await done;
    expect(saves).toHaveLength(1);
    expect(captured).toEqual([{ path: 'a.md', content: 'my edit', origin: 'conflict' }]);
    const doc = service.docFor(KEY);
    expect(doc?.bufferContent).toBe('theirs');
    expect(doc?.savedContent).toBe('theirs');
    expect(doc?.modifiedMs).toBe(900);
  });

  it('"Cancel" writes nothing and keeps the tab dirty', async () => {
    await openAndEdit();
    disk = { content: 'theirs', modifiedMs: 900 };
    const done = service.save({ key: KEY });
    await answerWhenAsked('cancel');
    await done;
    expect(saves).toHaveLength(1);
    expect(disk.content).toBe('theirs');
    expect(service.docFor(KEY)?.bufferContent).toBe('my edit');
    expect(service.isSaving()).toBe(false);
  });

  it('a save of an assistant-edited tab says so', async () => {
    await service.openFile('a.md', 'v1');
    service.setEditLock(KEY, true);
    service.updateBuffer(KEY, 'assistant text');
    service.setEditLock(KEY, false);
    await service.save({ key: KEY });
    service.updateBuffer(KEY, 'typed afterwards');
    await service.save({ key: KEY });
    expect(saves.map((s) => s.origin)).toEqual(['assistant', undefined]);
  });

  describe('watcher round', () => {
    it('marks a dirty tab instead of touching it', async () => {
      await openAndEdit();
      disk = { content: 'theirs', modifiedMs: 900 };
      await service.reloadFromVaultChange('v1', ['a.md']);
      const doc = service.docFor(KEY);
      expect(doc?.diskChanged).toBe(true);
      expect(doc?.bufferContent).toBe('my edit');
    });

    it('records the previous text when a clean tab reloads', async () => {
      await service.openFile('a.md', 'v1');
      disk = { content: 'theirs', modifiedMs: 900 };
      await service.reloadFromVaultChange('v1', ['a.md']);
      expect(captured).toEqual([{ path: 'a.md', content: 'original', origin: 'external' }]);
      expect(service.docFor(KEY)?.bufferContent).toBe('theirs');
    });

    it('"Keep mine" on the mark records the disk version and clears it; the next save goes through', async () => {
      await openAndEdit();
      disk = { content: 'theirs', modifiedMs: 900 };
      await service.reloadFromVaultChange('v1', ['a.md']);
      const done = service.resolveDiskChange(KEY);
      await answerWhenAsked('mine');
      await done;
      expect(captured).toEqual([{ path: 'a.md', content: 'theirs', origin: 'conflict' }]);
      expect(service.docFor(KEY)?.diskChanged).toBe(false);
      await service.save({ key: KEY });
      expect(saves).toHaveLength(1);
      expect(disk.content).toBe('my edit');
    });

    it('a merged result on the mark replaces the buffer and records both versions', async () => {
      await openAndEdit();
      disk = { content: 'theirs', modifiedMs: 900 };
      await service.reloadFromVaultChange('v1', ['a.md']);
      const done = service.resolveDiskChange(KEY);
      await answerWhenAsked({ merged: 'both' });
      await done;
      expect(captured.map((c) => c.content)).toEqual(['theirs', 'my edit']);
      const doc = service.docFor(KEY);
      expect(doc?.bufferContent).toBe('both');
      expect(doc?.savedContent).toBe('theirs');
      await service.save({ key: KEY });
      expect(saves).toHaveLength(1);
      expect(disk.content).toBe('both');
    });

    it('"Use disk version" on the mark reloads the tab', async () => {
      await openAndEdit();
      disk = { content: 'theirs', modifiedMs: 900 };
      await service.reloadFromVaultChange('v1', ['a.md']);
      const done = service.resolveDiskChange(KEY);
      await answerWhenAsked('disk');
      await done;
      const doc = service.docFor(KEY);
      expect(doc?.bufferContent).toBe('theirs');
      expect(doc?.diskChanged).toBe(false);
    });
  });
});
