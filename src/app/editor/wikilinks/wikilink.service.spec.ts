import { TestBed } from '@angular/core/testing';
import { DreyApi, VaultFileEntry } from '../../../../shared/ipc-api';
import { EditorService } from '../../services/editor.service';
import { WikilinkService } from './wikilink.service';

const V = 'v1';

const TREE: VaultFileEntry[] = [
  {
    name: 'notes',
    relativePath: 'notes',
    type: 'directory',
    children: [
      { name: 'plan.md', relativePath: 'notes/plan.md', type: 'file' },
      { name: 'todo.md', relativePath: 'notes/todo.md', type: 'file' },
    ],
  },
  { name: 'plan.md', relativePath: 'plan.md', type: 'file' },
  { name: 'journal.md', relativePath: 'daily/journal.md', type: 'file' },
  { name: 'pic.png', relativePath: 'pic.png', type: 'file' },
];

describe('WikilinkService', () => {
  let service: WikilinkService;
  let editor: EditorService;
  let created: string[];

  beforeEach(async () => {
    created = [];
    const fakeApi: Partial<DreyApi> = {
      getActiveVault: () => Promise.resolve('C:/vault'),
      getActiveVaultId: () => Promise.resolve(V),
      listVaults: () =>
        Promise.resolve([
          { id: V, name: 'vault', path: 'C:/vault', exists: true, active: true },
        ]),
      listVaultFiles: () => Promise.resolve(TREE),
      readVaultFile: (relativePath: string) =>
        // `## middle` sits on line 3 of the on-disk text.
        Promise.resolve({ content: '# Top\n\n## middle\n\n## Second\n\nbody\n', modifiedMs: 1 }),
      createVaultFile: (relativePath: string) => {
        created.push(relativePath);
        return Promise.resolve(relativePath);
      },
    };
    window.dreyApi = fakeApi as DreyApi;
    TestBed.resetTestingModule();
    service = TestBed.inject(WikilinkService);
    editor = TestBed.inject(EditorService);
    // Let the vault tree load so the per-vault index builds.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
    localStorage.removeItem('drey.editor');
  });

  describe('resolve', () => {
    it('resolves a unique basename case-insensitively', () => {
      expect(service.resolve('Journal', V, null)).toBe('daily/journal.md');
    });

    it('resolves a vault path with and without .md', () => {
      expect(service.resolve('notes/todo', V, null)).toBe('notes/todo.md');
      expect(service.resolve('notes/todo.md', V, null)).toBe('notes/todo.md');
    });

    it('prefers a sibling of the linking note among ambiguous basenames', () => {
      expect(service.resolve('plan', V, 'notes/todo.md')).toBe('notes/plan.md');
      expect(service.resolve('plan', V, 'daily/journal.md')).toBe('plan.md');
      expect(service.resolve('plan', V, null)).toBe('plan.md'); // shortest path wins
    });

    it('returns the linking note itself for an empty target', () => {
      expect(service.resolve('', V, 'notes/plan.md')).toBe('notes/plan.md');
      expect(service.resolve('  ', V, null)).toBeNull();
    });

    it('returns null for an unknown name', () => {
      expect(service.resolve('nope', V, null)).toBeNull();
    });
  });

  describe('noteNames', () => {
    it('lists markdown notes with unique-basename targets', () => {
      const notes = service.noteNames(V);
      const plan = notes.find((n) => n.path === 'notes/plan.md');
      const todo = notes.find((n) => n.path === 'notes/todo.md');
      const journal = notes.find((n) => n.path === 'daily/journal.md');
      expect(plan?.target).toBe('notes/plan'); // ambiguous basename -> path
      expect(todo?.target).toBe('todo'); // unique basename -> bare name
      expect(journal?.target).toBe('journal'); // unique -> bare name
      expect(notes.some((n) => n.path === 'pic.png')).toBe(false);
    });
  });

  describe('open', () => {
    it('opens a resolved note', async () => {
      await service.open('todo', null, V, null);
      expect(editor.activePath()).toBe(`${V}::notes/todo.md`);
    });

    it('jumps to a #heading anchor, found in the open buffer first', async () => {
      await service.open('todo', null, V, null);
      editor.updateBuffer(`${V}::notes/todo.md`, '# Top\n\n## Target here\n\ncontent\n');
      await service.open('todo', 'target here', V, 'notes/todo.md');
      // The first open() already bumped the request (id 1); this is id 2.
      expect(editor.revealRequest()).toMatchObject({ key: `${V}::notes/todo.md`, line: 3 });
    });

    it('reads the heading from disk when the note is not open', async () => {
      await service.open('journal', 'middle', V, null);
      expect(editor.revealRequest()).toEqual({
        id: 1,
        key: `${V}::daily/journal.md`,
        line: 3,
      });
    });

    it('falls back to line 1 when the anchor does not exist', async () => {
      await service.open('journal', 'nonexistent', V, null);
      expect(editor.revealRequest()).toEqual({
        id: 1,
        key: `${V}::daily/journal.md`,
        line: 1,
      });
    });

    it('creates a missing note (folders auto-created) in the linking vault and opens it', async () => {
      await service.open('projects/ideas', null, V, null);
      expect(created).toEqual(['projects/ideas.md']);
      expect(editor.activePath()).toBe(`${V}::projects/ideas.md`);
    });

    it('still opens when the create hits an "already exists" race', async () => {
      window.dreyApi = {
        ...window.dreyApi,
        createVaultFile: () => Promise.reject(new Error('Already exists: ideas.md')),
      } as unknown as DreyApi;
      await service.open('projects/ideas', null, V, null);
      expect(editor.activePath()).toBe(`${V}::projects/ideas.md`);
    });

    it('reports an unusable target instead of creating it', async () => {
      await service.open('../escape', null, V, null);
      expect(created).toEqual([]);
      expect(editor.activePath()).toBeNull();
      expect(editor.error()).toContain('Cannot create');
    });
  });

  describe('openResolvedOnly (the entry drawer)', () => {
    it('opens an existing note in the active vault', async () => {
      await service.openResolvedOnly('journal', null);
      expect(editor.activePath()).toBe(`${V}::daily/journal.md`);
    });

    it('does nothing -- and creates nothing -- when the target is unknown', async () => {
      await service.openResolvedOnly('missing note', null);
      expect(created).toEqual([]);
      expect(editor.activePath()).toBeNull();
    });
  });
});
