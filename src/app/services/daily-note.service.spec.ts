import { TestBed } from '@angular/core/testing';
import { DailyNoteService } from './daily-note.service';
import { EditorService } from './editor.service';
import { DreyApi } from '../../../shared/ipc-api';

describe('DailyNoteService', () => {
  let service: DailyNoteService;
  let editor: EditorService;
  let listeners: Array<(relativePath: string) => void>;
  let unsubscribed: number;

  beforeEach(() => {
    listeners = [];
    unsubscribed = 0;
    const fakeApi: Partial<DreyApi> = {
      readVaultFile: (relativePath: string) =>
        Promise.resolve({ content: `# ${relativePath}\n`, modifiedMs: 1 }),
      writeVaultFile: () => Promise.resolve(2),
      onOpenDailyNote: (listener: (relativePath: string) => void) => {
        listeners.push(listener);
        return () => {
          unsubscribed += 1;
        };
      },
    };
    window.dreyApi = fakeApi as DreyApi;
    service = TestBed.inject(DailyNoteService);
    editor = TestBed.inject(EditorService);
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  it('opens the pushed path and requests a new entry', async () => {
    service.start();
    expect(listeners.length).toBe(1);

    const before = editor.newEntryRequest().id;
    listeners[0]('daily/2026/09/2026-09-05.md');
    await Promise.resolve();
    await Promise.resolve();

    expect(editor.openPath()).toBe('daily/2026/09/2026-09-05.md');
    expect(editor.newEntryRequest().id).toBe(before + 1);
  });

  it('subscribes only once', () => {
    service.start();
    service.start();
    expect(listeners.length).toBe(1);
  });

  it('does nothing without the Electron bridge', () => {
    delete (window as { dreyApi?: unknown }).dreyApi;
    expect(() => service.start()).not.toThrow();
  });
});
