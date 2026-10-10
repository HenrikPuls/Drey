import { TestBed } from '@angular/core/testing';
import { DreyApi } from '../../../shared/ipc-api';
import { VaultService } from '../vault';
import { DocHistoryService } from './doc-history.service';
import { EditorService } from './editor.service';

/**
 * Drives the history through the real `EditorService`/`PaneService` flows
 * (open, close, activate) and flushes the recording `effect` with
 * `TestBed.tick()` -- the same way the dock/pane specs exercise signals.
 */
describe('DocHistoryService', () => {
  let editor: EditorService;
  let history: DocHistoryService;

  function useVault(id = 'v1'): void {
    const vault = TestBed.inject(VaultService);
    vault.vaults.set([{ id, name: 'V', path: 'C:\\v', exists: true, active: true }]);
    vault.activeVaultId.set(id);
  }

  /** Opens without the M32 clean-tab replacement, so tabs accumulate. */
  function openAside(path: string, vaultId = 'v1'): Promise<void> {
    return editor.openFile(path, vaultId, { keepFocused: true });
  }

  beforeEach(() => {
    window.dreyApi = {
      readVaultFile: (relativePath: string) =>
        Promise.resolve({ content: `content of ${relativePath}`, modifiedMs: 100 }),
    } as Partial<DreyApi> as DreyApi;
    editor = TestBed.inject(EditorService);
    history = TestBed.inject(DocHistoryService);
    useVault();
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
    localStorage.removeItem('drey.editor');
  });

  it('records every activation and enables back from the second document on', async () => {
    await editor.openFile('a.md');
    TestBed.tick();
    expect(history.canBack()).toBe(false);
    expect(history.canForward()).toBe(false);

    await openAside('b.md');
    TestBed.tick();
    expect(history.canBack()).toBe(true);
    expect(history.canForward()).toBe(false);
    expect(history.size()).toBe(2);
  });

  it('back/forward walk the pointer; the navigation itself never records', async () => {
    await editor.openFile('a.md');
    TestBed.tick();
    await openAside('b.md');
    TestBed.tick();

    await history.back();
    expect(editor.activePath()).toBe('v1::a.md');
    expect(history.canForward()).toBe(true);
    TestBed.tick();
    expect(history.size()).toBe(2);

    await history.forward();
    expect(editor.activePath()).toBe('v1::b.md');
    expect(history.canBack()).toBe(true);
  });

  it('a new activation after a back step truncates the forward branch', async () => {
    await editor.openFile('a.md');
    TestBed.tick();
    await openAside('b.md');
    TestBed.tick();
    await openAside('c.md');
    TestBed.tick();

    await history.back(); // now at b
    await openAside('d.md');
    TestBed.tick();

    expect(history.canForward()).toBe(false);
    expect(history.size()).toBe(3); // a, b, d
  });

  it('records consecutive activations of the same document once', async () => {
    await editor.openFile('a.md');
    TestBed.tick();
    editor.activate('v1::a.md');
    await editor.openFile('a.md');
    TestBed.tick();
    expect(history.size()).toBe(1);
  });

  it('reopens a closed vault document on back', async () => {
    await editor.openFile('a.md');
    TestBed.tick();
    await openAside('b.md');
    TestBed.tick();
    await editor.closeTab('v1::a.md');
    expect(editor.docFor('v1::a.md')).toBeNull();

    await history.back();

    expect(editor.docFor('v1::a.md')).not.toBeNull();
    expect(editor.activePath()).toBe('v1::a.md');
  });

  it('reopens a closed external document on back', async () => {
    window.dreyApi = {
      readVaultFile: (relativePath: string) =>
        Promise.resolve({ content: `content of ${relativePath}`, modifiedMs: 100 }),
      readExternalFile: () => Promise.resolve({ content: 'external', modifiedMs: 1 }),
    } as Partial<DreyApi> as DreyApi;
    await editor.openExternalFile('C:\\temp\\note.md');
    TestBed.tick();
    await openAside('a.md');
    TestBed.tick();
    await editor.closeTab('external://C:/temp/note.md');

    await history.back();

    expect(editor.activePath()).toBe('external://C:/temp/note.md');
  });

  it('skips and prunes entries it cannot restore (scratch tabs)', async () => {
    await editor.openFile('a.md');
    TestBed.tick();
    editor.openScratch('search-results.md', 'scratch');
    TestBed.tick();
    await openAside('b.md');
    TestBed.tick();
    // A closed scratch tab cannot be restored -- exactly the prune case.
    await editor.closeTab('search-results.md', { silent: true });
    expect(history.size()).toBe(3);

    await history.back();

    // The scratch key is gone from the history; the walk landed on a.md.
    expect(editor.activePath()).toBe('v1::a.md');
    expect(history.size()).toBe(2);
    expect(history.canBack()).toBe(false);
  });

  it('stays put when the only back candidate fails its reopen', async () => {
    await editor.openFile('a.md');
    TestBed.tick();
    await openAside('b.md');
    TestBed.tick();
    await editor.closeTab('v1::a.md');
    (window.dreyApi as Partial<DreyApi>).readVaultFile = () =>
      Promise.reject(new Error('gone'));

    await history.back();

    expect(editor.activePath()).toBe('v1::b.md');
    expect(history.canBack()).toBe(false);
    expect(history.size()).toBe(1);
  });

  it('does not record while suspended; resume seeds the landed-on document', async () => {
    history.suspend();
    await editor.openFile('a.md');
    TestBed.tick();
    expect(history.size()).toBe(0);

    history.resume();
    expect(history.size()).toBe(1);

    await openAside('b.md');
    TestBed.tick();
    expect(history.canBack()).toBe(true);
    await history.back();
    expect(editor.activePath()).toBe('v1::a.md');
  });

  it('drops the oldest entry past the limit (circular buffer)', async () => {
    (history as unknown as { limit: number }).limit = 3;
    await editor.openFile('a.md');
    TestBed.tick();
    await openAside('b.md');
    TestBed.tick();
    await openAside('c.md');
    TestBed.tick();
    await openAside('d.md');
    TestBed.tick();
    expect(history.size()).toBe(3);

    await history.back();
    await history.back();
    expect(editor.activePath()).toBe('v1::b.md');
    expect(history.canBack()).toBe(false);
  });
});
