import { TestBed } from '@angular/core/testing';
import { DreyApi, NoteHistoryEntry } from '../../../shared/ipc-api';
import { EditorService } from '../services/editor.service';
import { HistoryService, historyOriginLabel } from './history.service';

interface FakeDoc {
  key: string;
  kind: string;
  vaultId: string | null;
  path: string;
  savedContent: string;
  bufferContent: string;
  external?: boolean;
  askOnSave?: boolean;
}

describe('HistoryService', () => {
  let service: HistoryService;
  let docs: Record<string, FakeDoc>;
  const updateBuffer = vi.fn();
  const captured: Array<{ content: string; origin: string }> = [];
  const entries: NoteHistoryEntry[] = [
    { id: 'b', at: 2000, origin: 'assistant', bytes: 3 },
    { id: 'a', at: 1000, origin: 'save', bytes: 3 },
  ];

  beforeEach(() => {
    updateBuffer.mockClear();
    captured.length = 0;
    docs = {
      'v1::a.md': {
        key: 'v1::a.md',
        kind: 'text',
        vaultId: 'v1',
        path: 'a.md',
        savedContent: 'now',
        bufferContent: 'now',
      },
      'v1::chats/c.md': {
        key: 'v1::chats/c.md',
        kind: 'text',
        vaultId: 'v1',
        path: 'chats/c.md',
        savedContent: '',
        bufferContent: '',
      },
      'untitled.md': {
        key: 'untitled.md',
        kind: 'text',
        vaultId: null,
        path: 'untitled.md',
        savedContent: '',
        bufferContent: '',
        askOnSave: true,
      },
    };
    const api: Partial<DreyApi> = {
      listNoteHistory: () => Promise.resolve(entries),
      readNoteHistory: (_path: string, id: string) => Promise.resolve(id === 'b' ? 'newer\r\ntext' : 'older'),
      captureNoteHistory: (_path: string, content: string, origin: string) => {
        captured.push({ content, origin });
        return Promise.resolve(true);
      },
    };
    window.dreyApi = api as DreyApi;
    TestBed.configureTestingModule({
      providers: [
        {
          provide: EditorService,
          useValue: {
            docFor: (key: string) => docs[key] ?? null,
            activePath: () => 'v1::a.md',
            updateBuffer,
          },
        },
      ],
    });
    service = TestBed.inject(HistoryService);
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  it('offers a history for vault notes only', () => {
    expect(service.canShow('v1::a.md')).toBe(true);
    expect(service.canShow('v1::chats/c.md')).toBe(false);
    expect(service.canShow('untitled.md')).toBe(false);
    expect(service.canShow(null)).toBe(false);
  });

  it('opens on the focused note with the newest version selected, in LF form', async () => {
    await service.show();
    expect(service.target()).toEqual({ key: 'v1::a.md', path: 'a.md', vaultId: 'v1' });
    expect(service.selectedId()).toBe('b');
    expect(service.selectedContent()).toBe('newer\ntext');
    expect(service.current()).toBe('now');
  });

  it('restore puts the version into the editor buffer and closes', async () => {
    await service.show('v1::a.md');
    await service.select('a');
    service.restore();
    expect(updateBuffer).toHaveBeenCalledWith('v1::a.md', 'older');
    expect(captured).toEqual([]);
    expect(service.target()).toBeNull();
  });

  it('restore over unsaved edits records them first', async () => {
    docs['v1::a.md'].bufferContent = 'unsaved typing';
    await service.show('v1::a.md');
    service.restore();
    expect(captured).toEqual([{ content: 'unsaved typing', origin: 'restore' }]);
    expect(updateBuffer).toHaveBeenCalledWith('v1::a.md', 'newer\ntext');
  });

  it('labels origins, plugin ids included', () => {
    expect(historyOriginLabel('mcp')).toBe('Before an MCP write');
    expect(historyOriginLabel('tags')).toBe('Before a change by tags');
  });
});
