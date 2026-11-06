/**
 * req-101 — the Notes state: the list over folders / recent / search, the
 * note's View → edit → save cycle (cancel asks only when the text changed,
 * a save carries the read `mtime` as `baseMtime`, a conflict keeps the draft
 * and offers the disk text, a success adopts what the desk returns), the
 * read-only rule and the SSE refresh.
 */
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MC_NOTES_HOST,
  disconnectedNotesHost,
  errorKeyOf,
  newNotePathOf,
  ticketIdOf,
  type McNotesApi,
  type McNotesHost,
  type NoteReadReply,
  type NoteSaveReply,
} from './notes.model';
import { NotesStore, SEARCH_DEBOUNCE_MS } from './notes.store';

const read = (path: string, text: string, mtime: number, tags: readonly string[] = []): NoteReadReply => ({
  ok: true,
  path,
  name: path.split('/').pop()!.replace(/\.md$/, ''),
  text,
  body: text,
  tags,
  mtime,
});

interface Setup {
  store: NotesStore;
  api: { [K in keyof McNotesApi]: ReturnType<typeof vi.fn> };
  host: McNotesHost;
  readOnly: ReturnType<typeof signal<boolean>>;
  changed: ReturnType<typeof signal<{ seq: number; paths: readonly string[] }>>;
  toasts: string[];
  asked: string[];
  tickets: string[];
}

function setup(): Setup {
  const api = {
    notesList: vi.fn(async (folder?: string) => ({
      ok: true as const,
      vault: 'Main vault',
      folder: folder ?? '',
      folders: folder ? [] : [{ path: 'ideas', name: 'ideas' }],
      notes: [{ path: folder ? `${folder}/x.md` : 'a.md', name: folder ? 'x' : 'a', mtime: 5, size: 1 }],
    })),
    notesRecent: vi.fn(async () => ({
      ok: true as const,
      vault: 'Main vault',
      notes: [{ path: 'a.md', name: 'a', mtime: 9, size: 1 }],
    })),
    notesSearch: vi.fn(async (query: string) => ({
      ok: true as const,
      query,
      hits: [{ path: 'a.md', name: 'a', mtime: 9, size: 1, lines: [{ line: 3, heading: 'Plan', text: `the ${query}` }] }],
      truncated: false,
    })),
    notesRead: vi.fn(async (path: string): Promise<NoteReadReply> => read(path, `# ${path}\n\nbody #t\n`, 100, ['t'])),
    notesSave: vi.fn(async (path: string, text: string, _base: number): Promise<NoteSaveReply> => ({ ok: true, path, text, mtime: 200 })),
    notesCreate: vi.fn(async (path: string) => ({ ok: true as const, path, text: '', mtime: 300 })),
  };
  const readOnly = signal(false);
  const changed = signal<{ seq: number; paths: readonly string[] }>({ seq: 0, paths: [] });
  const toasts: string[] = [];
  const asked: string[] = [];
  const tickets: string[] = [];
  const host: McNotesHost = {
    api: api as unknown as McNotesApi,
    readOnly: () => readOnly(),
    changed,
    askAbout: (path) => asked.push(path),
    openTicket: (id) => tickets.push(id),
    toast: (message) => toasts.push(message),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [{ provide: MC_NOTES_HOST, useValue: host }] });
  return { store: TestBed.inject(NotesStore), api, host, readOnly, changed, toasts, asked, tickets };
}

afterEach(() => vi.useRealTimers());

describe('pure helpers', () => {
  it('reads the ticket a note names in its frontmatter', () => {
    expect(ticketIdOf('---\ntitle: x\nticket: T-0123\n---\nbody')).toBe('T-0123');
    expect(ticketIdOf('---\nticket: "T-9"\n---\n')).toBe('T-9');
    expect(ticketIdOf('---\ntitle: x\n---\nticket: T-1')).toBeNull();
    expect(ticketIdOf('no fence\nticket: T-1')).toBeNull();
  });

  it('builds a new note path in the open folder', () => {
    expect(newNotePathOf('', 'Idea')).toBe('Idea.md');
    expect(newNotePathOf('ideas', 'Idea.md')).toBe('ideas/Idea.md');
    expect(newNotePathOf('ideas', '  ')).toBeNull();
    expect(newNotePathOf('', '../x')).toBeNull();
  });

  it('maps a refusal code to a catalog key and falls back to internal', () => {
    expect(errorKeyOf('read_only')).toBe('notes.error.read_only');
    expect(errorKeyOf('something_new')).toBe('notes.error.internal');
  });
});

describe('the list', () => {
  it('loads the root folder and the recent notes, naming the vault', async () => {
    const { store, api } = setup();
    await store.loadHome();
    expect(api.notesList).toHaveBeenCalledWith('');
    expect(store.vault()).toBe('Main vault');
    expect(store.folders().map((f) => f.name)).toEqual(['ideas']);
    expect(store.recent().map((n) => n.name)).toEqual(['a']);
  });

  it('opens a folder and goes back up', async () => {
    const { store } = setup();
    await store.loadHome();
    await store.openFolder('ideas');
    expect(store.folder()).toBe('ideas');
    expect(store.notes()[0]!.path).toBe('ideas/x.md');
    await store.upFolder();
    expect(store.folder()).toBe('');
  });

  it('shows a refusal as words, never the English text', async () => {
    const { store, api } = setup();
    api.notesList.mockResolvedValueOnce({ ok: false, code: 'no_vault', error: 'raw english' } as never);
    await store.openFolder('');
    expect(store.listError()).toBe('The vault is not available on the desk right now.');
  });

  it('searches after a pause, only the last query, and an empty field returns to the list', async () => {
    vi.useFakeTimers();
    const { store, api } = setup();
    store.setQuery('pl');
    store.setQuery('plan');
    expect(api.notesSearch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(api.notesSearch).toHaveBeenCalledTimes(1);
    expect(api.notesSearch).toHaveBeenCalledWith('plan');
    expect(store.hits()).toHaveLength(1);
    expect(store.searched()).toBe('plan');
    store.setQuery('');
    expect(store.hits()).toEqual([]);
    expect(store.searched()).toBe('');
  });
});

describe('the note: View, edit, cancel', () => {
  it('opens in View with its tags and the ticket link', async () => {
    const { store, api } = setup();
    api.notesRead.mockResolvedValueOnce(read('a.md', '---\nticket: T-0007\n---\n# A\n', 100, ['t']));
    await store.open('a.md');
    expect(store.mode()).toBe('view');
    expect(store.editing()).toBe(false);
    expect(store.tags()).toEqual(['t']);
    expect(store.ticketId()).toBe('T-0007');
  });

  it('the pencil starts Live Preview; picking Source in View edits in Source', async () => {
    const { store } = setup();
    await store.open('a.md');
    store.startEdit();
    expect(store.editing()).toBe(true);
    expect(store.mode()).toBe('live');
    store.cancel();
    store.pickMode('source');
    expect(store.editing()).toBe(true);
    expect(store.mode()).toBe('source');
  });

  it('cancel leaves at once when nothing changed', async () => {
    const { store } = setup();
    await store.open('a.md');
    store.startEdit();
    store.cancel();
    expect(store.discardAsk()).toBeNull();
    expect(store.editing()).toBe(false);
  });

  it('cancel asks when the text changed; keep editing keeps the draft, discard drops it', async () => {
    const { store } = setup();
    await store.open('a.md');
    store.startEdit();
    store.setDraft('changed');
    store.cancel();
    expect(store.discardAsk()).toEqual({ kind: 'cancel' });
    expect(store.editing()).toBe(true);
    store.keepEditing();
    expect(store.discardAsk()).toBeNull();
    expect(store.draft()).toBe('changed');
    store.cancel();
    await store.confirmDiscard();
    expect(store.editing()).toBe(false);
    expect(store.draft()).toBe(store.base());
  });

  it('opening another note or leaving asks while the draft is dirty', async () => {
    const { store } = setup();
    await store.open('a.md');
    store.startEdit();
    store.setDraft('changed');
    await store.open('b.md');
    expect(store.path()).toBe('a.md');
    expect(store.discardAsk()).toEqual({ kind: 'leave', then: 'b.md' });
    await store.confirmDiscard();
    expect(store.path()).toBe('b.md');
    expect(store.editing()).toBe(false);
    store.leave();
    expect(store.path()).toBeNull();
  });
});

describe('saving', () => {
  it('sends the whole text with the read mtime as baseMtime and adopts what the desk returns', async () => {
    const { store, api, toasts } = setup();
    api.notesSave.mockResolvedValueOnce({ ok: true, path: 'a.md', text: 'new text\nupdated: now', mtime: 250 });
    await store.open('a.md');
    api.notesRead.mockResolvedValue(read('a.md', 'new text\nupdated: now', 250, ['t']));
    store.startEdit();
    store.setDraft('new text');
    await store.save();
    expect(api.notesSave).toHaveBeenCalledWith('a.md', 'new text', 100);
    expect(store.base()).toBe('new text\nupdated: now');
    expect(store.draft()).toBe('new text\nupdated: now');
    expect(store.mtime()).toBe(250);
    expect(store.editing()).toBe(false);
    expect(store.mode()).toBe('view');
    expect(toasts).toEqual(['Note saved.']);
  });

  it('a conflict keeps the draft and the editor, offers the disk text, and Keep mine saves over the disk mtime', async () => {
    const { store, api } = setup();
    api.notesSave.mockResolvedValueOnce({ ok: false, code: 'conflict', error: 'x', disk: { text: 'disk text', mtime: 400 } });
    await store.open('a.md');
    store.startEdit();
    store.setDraft('mine');
    await store.save();
    expect(store.conflict()).toEqual({ text: 'disk text', mtime: 400 });
    expect(store.editing()).toBe(true);
    expect(store.draft()).toBe('mine');
    await store.keepMine();
    expect(api.notesSave).toHaveBeenLastCalledWith('a.md', 'mine', 400);
    expect(store.conflict()).toBeNull();
    expect(store.editing()).toBe(false);
  });

  it("a conflict's Keep the desk's adopts the disk text and leaves editing", async () => {
    const { store, api } = setup();
    api.notesSave.mockResolvedValueOnce({ ok: false, code: 'conflict', error: 'x', disk: { text: 'disk text', mtime: 400 } });
    await store.open('a.md');
    store.startEdit();
    store.setDraft('mine');
    await store.save();
    store.keepTheirs();
    expect(store.base()).toBe('disk text');
    expect(store.draft()).toBe('disk text');
    expect(store.mtime()).toBe(400);
    expect(store.editing()).toBe(false);
    expect(store.conflict()).toBeNull();
  });

  it('a refusal keeps editing and says why', async () => {
    const { store, api } = setup();
    api.notesSave.mockResolvedValueOnce({ ok: false, code: 'not_found', error: 'x' });
    await store.open('a.md');
    store.startEdit();
    store.setDraft('mine');
    await store.save();
    expect(store.editing()).toBe(true);
    expect(store.saveError()).toBe('That note is not there any more.');
  });
});

describe('the read-only rule', () => {
  it('a read-only device cannot start editing, pick Live or Source, or create a note', async () => {
    const { store, readOnly, api } = setup();
    readOnly.set(true);
    await store.open('a.md');
    store.startEdit();
    store.pickMode('live');
    store.pickMode('source');
    expect(store.editing()).toBe(false);
    expect(store.pickMode).toBeDefined();
    expect(await store.create('Idea')).toBe('This device is read-only.');
    expect(api.notesCreate).not.toHaveBeenCalled();
  });
});

describe('a new note', () => {
  it('creates it in the open folder, opens it and starts editing', async () => {
    const { store, api } = setup();
    await store.loadHome();
    await store.openFolder('ideas');
    expect(await store.create('Fresh')).toBeNull();
    expect(api.notesCreate).toHaveBeenCalledWith('ideas/Fresh.md', '');
    expect(store.path()).toBe('ideas/Fresh.md');
    expect(store.editing()).toBe(true);
  });

  it('says so when the name exists', async () => {
    const { store, api } = setup();
    api.notesCreate.mockResolvedValueOnce({ ok: false, code: 'exists', error: 'x' } as never);
    expect(await store.create('Fresh')).toBe('A note with that name already exists.');
  });
});

describe('the SSE notes event', () => {
  beforeEach(() => undefined);

  it('refreshes the lists and reloads the open note unless there are unsaved changes', async () => {
    const { store, api, changed } = setup();
    await store.open('a.md');
    api.notesRead.mockClear();
    changed.set({ seq: 1, paths: ['a.md'] });
    TestBed.tick();
    await vi.waitFor(() => expect(api.notesRead).toHaveBeenCalledWith('a.md'));
    expect(api.notesList).toHaveBeenCalled();

    store.startEdit();
    store.setDraft('mine');
    api.notesRead.mockClear();
    changed.set({ seq: 2, paths: ['a.md'] });
    TestBed.tick();
    await vi.waitFor(() => expect(api.notesList.mock.calls.length).toBeGreaterThan(1));
    expect(api.notesRead).not.toHaveBeenCalled();
    expect(store.draft()).toBe('mine');
  });
});

describe('the shell seams', () => {
  it('Ask about this note and the ticket link go to the host', async () => {
    const { store, api, asked, tickets } = setup();
    api.notesRead.mockResolvedValueOnce(read('a.md', '---\nticket: T-1\n---\n', 1));
    await store.open('a.md');
    store.askAbout();
    store.openTicket();
    expect(asked).toEqual(['a.md']);
    expect(tickets).toEqual(['T-1']);
  });

  it('a disconnected host answers offline', async () => {
    const reply = await disconnectedNotesHost().api.notesList();
    expect(reply.ok).toBe(false);
  });
});
