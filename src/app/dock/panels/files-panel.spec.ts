import { TestBed, ComponentFixture } from '@angular/core/testing';
import { DreyApi, VaultFileEntry, VaultStatus } from '../../../../shared/ipc-api';
import { EditorService } from '../../services/editor.service';
import { VaultService } from '../../vault';
import { FilesPanel } from './files-panel';

const V = 'v1';
const V2 = 'v2';

/** The `dragstart` handlers are `protected`; reach them through a cast. */
type DragStartHost = {
  onFileDragStart(event: DragEvent, vaultId: string, entry: VaultFileEntry): void;
};

/** The keyboard selection is `protected` too. */
type SelectionHost = { selected(): string | null; selection(): ReadonlySet<string> };

/** The in-panel drag state + handlers (req-23, ADR-0051), all `protected`. */
type DragHost = {
  dragEntry(): { vaultId: string; entry: VaultFileEntry } | null;
  dropHover(): string | null;
  onFileDragStart(event: DragEvent, vaultId: string, entry: VaultFileEntry): void;
  onFolderDragStart(event: DragEvent, vaultId: string, entry: VaultFileEntry): void;
  onDragEnd(): void;
  onRowDragOver(event: DragEvent, vaultId: string, entry: VaultFileEntry): void;
  onRowDragLeave(event: DragEvent, vaultId: string, entry: VaultFileEntry): void;
  onRowDrop(event: DragEvent, vaultId: string, entry: VaultFileEntry): void;
  onVaultRowDragOver(event: DragEvent, vault: VaultStatus): void;
  onVaultRowDrop(event: DragEvent, vault: VaultStatus): void;
};

function fakeDataTransfer(): DataTransfer {
  const store: Record<string, string> = {};
  return {
    setData: (type: string, value: string) => {
      store[type] = value;
    },
    getData: (type: string) => store[type] ?? '',
    effectAllowed: 'none',
  } as unknown as DataTransfer;
}

/** One active vault so every keyed expectation is `v1::…`. */
function registryApi(overrides: Partial<DreyApi> = {}): Partial<DreyApi> {
  return {
    getActiveVault: () => Promise.resolve('C:/vault'),
    getActiveVaultId: () => Promise.resolve(V),
    listVaults: () =>
      Promise.resolve([
        { id: V, name: 'vault', path: 'C:/vault', exists: true, active: true },
      ]),
    listVaultFiles: () => Promise.resolve([]),
    ...overrides,
  };
}

describe('FilesPanel.onFileDragStart', () => {
  let host: DragStartHost;

  beforeEach(async () => {
    window.dreyApi = registryApi() as DreyApi;
    await TestBed.configureTestingModule({ imports: [FilesPanel] }).compileComponents();
    host = TestBed.createComponent(FilesPanel).componentInstance as unknown as DragStartHost;
  });

  afterEach(() => delete (window as { dreyApi?: unknown }).dreyApi);

  it('carries the doc key (vaultId::path) + the bare path for a file', () => {
    const dt = fakeDataTransfer();
    host.onFileDragStart({ dataTransfer: dt } as DragEvent, V, {
      name: 'logo.png',
      relativePath: 'assets/logo.png',
      type: 'file',
    });
    expect(dt.getData('application/x-drey-vault-path')).toBe(`${V}::assets/logo.png`);
    expect(dt.getData('text/plain')).toBe('assets/logo.png');
    expect(dt.effectAllowed).toBe('copyLink');
  });

  it('sets nothing for a directory', () => {
    const dt = fakeDataTransfer();
    host.onFileDragStart({ dataTransfer: dt } as DragEvent, V, {
      name: 'assets',
      relativePath: 'assets',
      type: 'directory',
    });
    expect(dt.getData('application/x-drey-vault-path')).toBe('');
  });
});

/** vault row · a.md · notes/ · notes/b.md -- four visible rows in display order. */
function tree(): VaultFileEntry[] {
  return [
    { name: 'a.md', relativePath: 'a.md', type: 'file' },
    {
      name: 'notes',
      relativePath: 'notes',
      type: 'directory',
      children: [{ name: 'b.md', relativePath: 'notes/b.md', type: 'file' }],
    },
  ];
}

describe('FilesPanel row tooltips (req: full path on hover)', () => {
  let fixture: ComponentFixture<FilesPanel>;

  function setup(vaultPath: string): void {
    window.dreyApi = registryApi({
      listVaults: () =>
        Promise.resolve([{ id: V, name: 'vault', path: vaultPath, exists: true, active: true }]),
      listVaultFiles: () => Promise.resolve(tree()),
    }) as DreyApi;
  }

  async function render(): Promise<NodeListOf<HTMLElement>> {
    await TestBed.configureTestingModule({ imports: [FilesPanel] }).compileComponents();
    fixture = TestBed.createComponent(FilesPanel);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelectorAll('.node').length).toBe(4);
    });
    return fixture.nativeElement.querySelectorAll('.node');
  }

  afterEach(() => {
    fixture.nativeElement.remove();
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  it('file and folder rows carry the absolute path as their tooltip (posix root)', async () => {
    setup('C:/vault');
    const rows = await render();

    expect(rows[1].getAttribute('title')).toBe('C:/vault/a.md');
    expect(rows[2].getAttribute('title')).toBe('C:/vault/notes');
    expect(rows[3].getAttribute('title')).toBe('C:/vault/notes/b.md');
  });

  it('joins with a backslash when the vault root uses one (Windows root)', async () => {
    setup('E:\\notes');
    const rows = await render();

    expect(rows[1].getAttribute('title')).toBe('E:\\notes\\a.md');
    expect(rows[3].getAttribute('title')).toBe('E:\\notes\\notes\\b.md');
  });
});

describe('FilesPanel keyboard navigation (bug-7)', () => {

  let fixture: ComponentFixture<FilesPanel>;

  beforeAll(() => {
    // jsdom implements focus() but not scrollIntoView; `select()` calls both.
    // Left in place for the whole file: `select()`'s setTimeout can escape a
    // synchronous test, and a deleted stub would turn that into an uncaught
    // error.
    Element.prototype.scrollIntoView = vi.fn();
  });

  beforeEach(async () => {
    window.dreyApi = registryApi({ listVaultFiles: () => Promise.resolve(tree()) }) as DreyApi;
    await TestBed.configureTestingModule({ imports: [FilesPanel] }).compileComponents();
    fixture = TestBed.createComponent(FilesPanel);
    // `focus()` only takes effect on connected elements (jsdom follows the
    // spec here), and the focus-follow IS the fix under test.
    document.body.appendChild(fixture.nativeElement);
  });

  afterEach(() => {
    fixture.nativeElement.remove();
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  function rows(): NodeListOf<HTMLElement> {
    return fixture.nativeElement.querySelectorAll('.node');
  }

  function treeScroll(): HTMLElement {
    return fixture.nativeElement.querySelector('.tree-scroll');
  }

  async function renderTree(): Promise<void> {
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(rows().length).toBe(4); // vault row + a.md + notes + notes/b.md
    });
  }

  /** Arrow keys settle the selection synchronously; the focus-follow is a `setTimeout`. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    fixture.detectChanges();
  }

  function pressKey(
    key: string,
    target?: HTMLElement,
    modifiers?: { shiftKey?: boolean; ctrlKey?: boolean },
  ): void {
    (target ?? treeScroll()).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, ...modifiers }),
    );
  }

  it('ArrowDown moves the selection AND DOM focus onto the new row', async () => {
    await renderTree();
    const host = fixture.componentInstance as unknown as SelectionHost;
    expect(host.selected()).toBeNull();

    pressKey('ArrowDown'); // the vault row
    expect(host.selected()).toBe(V);
    await settle();
    expect(document.activeElement).toBe(rows()[0]);

    pressKey('ArrowDown'); // a.md
    expect(host.selected()).toBe(`${V}::a.md`);
    await settle();
    expect(document.activeElement).toBe(rows()[1]);
  });

  it('keeps one tab stop: only the selected row is tabbable', async () => {
    await renderTree();
    pressKey('ArrowDown');
    fixture.detectChanges();
    const tabbable = [...rows()].filter((row) => row.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0].classList.contains('selected')).toBe(true);
    await settle(); // let select()'s focus timer fire inside the test
  });

  it('Enter from the tree container opens the highlighted file in its vault', async () => {
    await renderTree();
    const editor = TestBed.inject(EditorService);
    const openFile = vi.spyOn(editor, 'openFile').mockResolvedValue(undefined);

    pressKey('ArrowDown'); // vault row
    pressKey('ArrowDown'); // a.md
    fixture.detectChanges();
    pressKey('Enter', treeScroll()); // container-focused branch (target === currentTarget)

    expect(openFile).toHaveBeenCalledWith('a.md', V);
    await settle(); // let select()'s focus timer fire inside the test
  });

  it('the active vault row carries the marker; click folds the section', async () => {
    await renderTree();
    const vaultRow = fixture.nativeElement.querySelector('.node.vault-row');
    expect(vaultRow.classList.contains('active-vault')).toBe(true);
    expect(vaultRow.querySelector('.active-dot')).not.toBeNull();

    vaultRow.click();
    fixture.detectChanges();
    expect(rows().length).toBe(1); // the section folded away
  });
});

describe('FilesPanel multi-select (bug-8)', () => {
  /** vault row · a.md · notes/ · notes/b.md -- four visible rows. */
  function tree(): VaultFileEntry[] {
    return [
      { name: 'a.md', relativePath: 'a.md', type: 'file' },
      {
        name: 'notes',
        relativePath: 'notes',
        type: 'directory',
        children: [{ name: 'b.md', relativePath: 'notes/b.md', type: 'file' }],
      },
    ];
  }

  let fixture: ComponentFixture<FilesPanel>;
  let deleted: Array<{ vaultId?: string; paths: string[] }>;

  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  beforeEach(async () => {
    deleted = [];
    window.dreyApi = registryApi({
      listVaultFiles: () => Promise.resolve(tree()),
      deleteVaultEntries: (paths: string[], vaultId?: string) => {
        deleted.push({ vaultId, paths });
        return Promise.resolve();
      },
    }) as DreyApi;
    await TestBed.configureTestingModule({ imports: [FilesPanel] }).compileComponents();
    fixture = TestBed.createComponent(FilesPanel);
    document.body.appendChild(fixture.nativeElement);
  });

  afterEach(() => {
    fixture.nativeElement.remove();
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  function rows(): NodeListOf<HTMLElement> {
    return fixture.nativeElement.querySelectorAll('.node');
  }

  function treeScroll(): HTMLElement {
    return fixture.nativeElement.querySelector('.tree-scroll');
  }

  function host(): SelectionHost {
    return fixture.componentInstance as unknown as SelectionHost;
  }

  async function renderTree(): Promise<void> {
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(rows().length).toBe(4);
    });
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    fixture.detectChanges();
  }

  function pressKey(
    key: string,
    modifiers?: { shiftKey?: boolean; ctrlKey?: boolean },
    target?: HTMLElement,
  ): void {
    (target ?? treeScroll()).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, ...modifiers }),
    );
  }

  function clickRow(index: number, modifiers?: { shiftKey?: boolean; ctrlKey?: boolean }): void {
    rows()[index].dispatchEvent(new MouseEvent('click', { bubbles: true, ...modifiers }));
  }

  it('plain click selects alone; Ctrl+click toggles rows into the set', async () => {
    await renderTree();
    const editor = TestBed.inject(EditorService);
    vi.spyOn(editor, 'openFile').mockResolvedValue(undefined);

    clickRow(1); // a.md, plain
    expect(host().selection()).toEqual(new Set([`${V}::a.md`]));

    clickRow(3, { ctrlKey: true }); // notes/b.md joins
    expect(host().selection()).toEqual(new Set([`${V}::a.md`, `${V}::notes/b.md`]));
    expect(host().selected()).toBe(`${V}::notes/b.md`);

    clickRow(3, { ctrlKey: true }); // toggles back out
    expect(host().selection()).toEqual(new Set([`${V}::a.md`]));
    await settle();
  });

  it('Shift+click and Shift+ArrowDown extend a range over the visible rows', async () => {
    await renderTree();
    const editor = TestBed.inject(EditorService);
    vi.spyOn(editor, 'openFile').mockResolvedValue(undefined);

    clickRow(1); // anchor = a.md
    clickRow(3, { shiftKey: true }); // range a.md..notes/b.md
    expect(host().selection()).toEqual(
      new Set([`${V}::a.md`, `${V}::notes`, `${V}::notes/b.md`]),
    );

    // Fresh anchor, then keyboard extension.
    clickRow(1);
    pressKey('ArrowDown', { shiftKey: true });
    expect(host().selection()).toEqual(new Set([`${V}::a.md`, `${V}::notes`]));
    await settle();
  });

  it('Ctrl+Arrow moves the cursor without changing the selection', async () => {
    await renderTree();
    pressKey('ArrowDown'); // vault row
    pressKey('ArrowDown'); // cursor + selection = a.md
    pressKey('ArrowDown', { ctrlKey: true }); // cursor -> notes, selection stays
    expect(host().selected()).toBe(`${V}::notes`);
    expect(host().selection()).toEqual(new Set([`${V}::a.md`]));
    await settle();
  });

  it('Enter opens every selected file once (folders skipped)', async () => {
    await renderTree();
    const editor = TestBed.inject(EditorService);
    const openFile = vi.spyOn(editor, 'openFile').mockResolvedValue(undefined);

    clickRow(1); // a.md (the plain click itself opens it)
    clickRow(3, { ctrlKey: true }); // notes/b.md joins
    openFile.mockClear(); // count only what Enter opens
    pressKey('Enter', undefined, treeScroll());

    await settle();
    const opened = openFile.mock.calls.map((call) => call.slice(0, 2));
    expect(opened).toEqual([
      ['a.md', V],
      ['notes/b.md', V],
    ]);
  });

  it('Delete removes the whole selection in ONE batched IPC call', async () => {
    await renderTree();
    const confirmDialog = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const closeTabsUnder = vi.spyOn(TestBed.inject(EditorService), 'closeTabsUnder');

    clickRow(1); // a.md
    clickRow(3, { ctrlKey: true }); // notes/b.md
    pressKey('Delete');

    await vi.waitFor(() => expect(deleted).toHaveLength(1));
    expect(deleted[0]).toEqual({ vaultId: V, paths: ['a.md', 'notes/b.md'] });
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(closeTabsUnder).toHaveBeenCalledTimes(2);
    await settle();
  });

  it('Delete clears a clipboard entry that lived under a deleted folder', async () => {
    await renderTree();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const vault = TestBed.inject(VaultService);
    vault.clipboard.set({ vaultId: V, path: 'notes/b.md', name: 'b.md' });

    clickRow(1); // a.md
    clickRow(3, { ctrlKey: true }); // notes/b.md
    pressKey('Delete');

    await vi.waitFor(() => expect(deleted).toHaveLength(1));
    expect(vault.clipboard()).toBeNull();
    await settle();
  });

  it('Escape collapses a multi-selection back to the cursor row', async () => {
    await renderTree();
    const editor = TestBed.inject(EditorService);
    vi.spyOn(editor, 'openFile').mockResolvedValue(undefined);

    clickRow(1);
    clickRow(3, { ctrlKey: true });
    expect(host().selection().size).toBe(2);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(host().selection()).toEqual(new Set([`${V}::notes/b.md`])); // the cursor row
    await settle();
  });
});

describe('FilesPanel drag & drop (req-23 + cross-vault, ADR-0051)', () => {
  /** vault row · a.md · notes/ · notes/b.md · archive/ -- five visible rows. */
  function tree(): VaultFileEntry[] {
    return [
      { name: 'a.md', relativePath: 'a.md', type: 'file' },
      {
        name: 'notes',
        relativePath: 'notes',
        type: 'directory',
        children: [{ name: 'b.md', relativePath: 'notes/b.md', type: 'file' }],
      },
      { name: 'archive', relativePath: 'archive', type: 'directory', children: [] },
    ];
  }

  let fixture: ComponentFixture<FilesPanel>;
  let renamed: Array<{ from: string; to: string; fromVaultId?: string; toVaultId?: string }>;
  let vaults: VaultStatus[];

  /** jsdom has no DragEvent -- plain objects with recorded prevent/stop. */
  function dragEvent(
    options: { target?: EventTarget | null; dt?: DataTransfer } = {},
  ): { event: DragEvent; prevented(): boolean; stopped(): boolean } {
    let prevented = false;
    let stopped = false;
    const event = {
      dataTransfer: options.dt ?? fakeDataTransfer(),
      target: options.target ?? null,
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {
        stopped = true;
      },
    } as unknown as DragEvent;
    return { event, prevented: () => prevented, stopped: () => stopped };
  }

  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  beforeEach(async () => {
    renamed = [];
    vaults = [
      { id: V, name: 'vault', path: 'C:/vault', exists: true, active: true },
      { id: V2, name: 'second', path: 'D:/second', exists: true, active: false },
    ];
    window.dreyApi = registryApi({
      listVaults: () => Promise.resolve(vaults),
      listVaultFiles: (vaultId) => Promise.resolve(vaultId === V2 ? [] : tree()),
      renameVaultEntry: (fromRel: string, toRel: string, fromVaultId?: string, toVaultId?: string) => {
        renamed.push({ from: fromRel, to: toRel, fromVaultId, toVaultId });
        return Promise.resolve(toRel);
      },
    }) as DreyApi;
    await TestBed.configureTestingModule({ imports: [FilesPanel] }).compileComponents();
    fixture = TestBed.createComponent(FilesPanel);
    document.body.appendChild(fixture.nativeElement);
  });

  afterEach(() => {
    fixture.nativeElement.remove();
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  function rows(): NodeListOf<HTMLElement> {
    return fixture.nativeElement.querySelectorAll('.node');
  }

  function host(): DragHost {
    return fixture.componentInstance as unknown as DragHost;
  }

  async function renderTree(): Promise<void> {
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(rows().length).toBe(6); // two vault rows + four entries
    });
  }

  const aMd = { name: 'a.md', relativePath: 'a.md', type: 'file' } as VaultFileEntry;
  const notes = { name: 'notes', relativePath: 'notes', type: 'directory' } as VaultFileEntry;
  const bMd = { name: 'b.md', relativePath: 'notes/b.md', type: 'file' } as VaultFileEntry;

  it('a folder dragstart arms the move but sets no dataTransfer types', () => {
    const dt = fakeDataTransfer();
    host().onFolderDragStart({ dataTransfer: dt } as DragEvent, V, notes);
    expect(dt.getData('application/x-drey-vault-path')).toBe('');
    expect(host().dragEntry()).toEqual({ vaultId: V, entry: notes });
    host().onDragEnd();
    expect(host().dragEntry()).toBeNull();
  });

  it('a file dragstart carries the editor-drop types AND arms the move', () => {
    const dt = fakeDataTransfer();
    host().onFileDragStart({ dataTransfer: dt } as DragEvent, V, aMd);
    expect(dt.getData('application/x-drey-vault-path')).toBe(`${V}::a.md`);
    expect(host().dragEntry()).toEqual({ vaultId: V, entry: aMd });
  });

  it('dragover marks a valid folder target and leaves a no-op target untouched', async () => {
    await renderTree();
    host().onFileDragStart({ dataTransfer: fakeDataTransfer() } as DragEvent, V, aMd);

    const ontoNotes = dragEvent();
    host().onRowDragOver(ontoNotes.event, V, notes);
    expect(ontoNotes.prevented()).toBe(true); // drop allowed
    expect(host().dropHover()).toBe(`${V}::notes`);

    const ontoSelf = dragEvent(); // a.md onto a.md: same dir -> no-op
    host().onRowDragOver(ontoSelf.event, V, aMd);
    expect(ontoSelf.prevented()).toBe(false);
    expect(host().dropHover()).toBe(`${V}::notes`); // unchanged
  });

  it('refuses a folder dropped into itself or its own subtree', async () => {
    await renderTree();
    host().onFolderDragStart({ dataTransfer: fakeDataTransfer() } as DragEvent, V, notes);

    const ontoItself = dragEvent();
    host().onRowDragOver(ontoItself.event, V, notes); // dest 'notes' === dragged
    expect(ontoItself.prevented()).toBe(false);

    const intoChild = dragEvent(); // notes onto notes/b.md -> dest is 'notes' again
    host().onRowDragOver(intoChild.event, V, bMd);
    expect(intoChild.prevented()).toBe(false);
  });

  it('drop on a folder moves the file, retargets tabs, follows the clipboard', async () => {
    await renderTree();
    const editor = TestBed.inject(EditorService);
    const retarget = vi.spyOn(editor, 'retargetTabs');
    const vault = TestBed.inject(VaultService);
    vault.clipboard.set({ vaultId: V, path: 'a.md', name: 'a.md' });

    host().onFileDragStart({ dataTransfer: fakeDataTransfer() } as DragEvent, V, aMd);
    const drop = dragEvent();
    host().onRowDrop(drop.event, V, notes);

    await vi.waitFor(() =>
      expect(retarget).toHaveBeenCalledWith(`${V}::a.md`, `${V}::notes/a.md`),
    );
    expect(renamed).toEqual([
      { from: 'a.md', to: 'notes/a.md', fromVaultId: V, toVaultId: V },
    ]);
    expect(vault.clipboard()).toEqual({ vaultId: V, path: 'notes/a.md', name: 'a.md' });
    expect(host().dragEntry()).toBeNull();
    expect(host().dropHover()).toBeNull();
    expect(drop.stopped()).toBe(true);
  });

  it('drop on a file row targets the folder that file lives in', async () => {
    await renderTree();
    host().onFileDragStart({ dataTransfer: fakeDataTransfer() } as DragEvent, V, aMd);
    host().onRowDrop(dragEvent().event, V, bMd);
    await vi.waitFor(() =>
      expect(renamed).toEqual([{ from: 'a.md', to: 'notes/a.md', fromVaultId: V, toVaultId: V }]),
    );
  });

  it('a collision alerts and leaves tabs and clipboard alone', async () => {
    await renderTree();
    window.dreyApi = {
      ...window.dreyApi,
      renameVaultEntry: () => Promise.reject(new Error('Already exists: notes/a.md')),
    } as unknown as DreyApi;
    const alertBox = vi.spyOn(window, 'alert').mockReturnValue(undefined);
    const retarget = vi.spyOn(TestBed.inject(EditorService), 'retargetTabs');

    host().onFileDragStart({ dataTransfer: fakeDataTransfer() } as DragEvent, V, aMd);
    host().onRowDrop(dragEvent().event, V, notes);

    await vi.waitFor(() => expect(alertBox).toHaveBeenCalled());
    expect(alertBox.mock.calls[0][0]).toContain('Already exists');
    expect(retarget).not.toHaveBeenCalled();
  });

  it('a drop on ANOTHER vault header row moves the entry across vaults', async () => {
    await renderTree();
    host().onFileDragStart({ dataTransfer: fakeDataTransfer() } as DragEvent, V, aMd);

    const second = { id: V2, name: 'second', path: 'D:/second', exists: true, active: false };
    const over = dragEvent();
    host().onVaultRowDragOver(over.event, second);
    expect(over.prevented()).toBe(true);
    expect(host().dropHover()).toBe(V2);

    const drop = dragEvent();
    host().onVaultRowDrop(drop.event, second);

    await vi.waitFor(() =>
      expect(renamed).toEqual([{ from: 'a.md', to: 'a.md', fromVaultId: V, toVaultId: V2 }]),
    );
    expect(drop.stopped()).toBe(true);
  });

  it('a drop on the vault\'s OWN header row hoists a nested entry to the root', async () => {
    await renderTree();
    host().onFileDragStart({ dataTransfer: fakeDataTransfer() } as DragEvent, V, bMd);

    const own = { id: V, name: 'vault', path: 'C:/vault', exists: true, active: true };
    const drop = dragEvent();
    host().onVaultRowDrop(drop.event, own);
    await vi.waitFor(() =>
      expect(renamed).toEqual([{ from: 'notes/b.md', to: 'b.md', fromVaultId: V, toVaultId: V }]),
    );
  });
});
