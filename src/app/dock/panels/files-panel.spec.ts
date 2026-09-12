import { TestBed, ComponentFixture } from '@angular/core/testing';
import { DreyApi, VaultFileEntry } from '../../../../shared/ipc-api';
import { EditorService } from '../../services/editor.service';
import { VaultService } from '../../vault';
import { FilesPanel } from './files-panel';

/** The `dragstart` handler is `protected`; reach it through a cast. */
type DragStartHost = { onFileDragStart(event: DragEvent, entry: VaultFileEntry): void };

/** The keyboard selection is `protected` too. */
type SelectionHost = { selected(): string | null; selection(): ReadonlySet<string> };

/** The in-panel drag state + handlers (req-23), all `protected`. */
type DragHost = {
  dragEntry(): VaultFileEntry | null;
  dropHover(): string | null;
  onFileDragStart(event: DragEvent, entry: VaultFileEntry): void;
  onFolderDragStart(event: DragEvent, entry: VaultFileEntry): void;
  onDragEnd(): void;
  onRowDragOver(event: DragEvent, entry: VaultFileEntry): void;
  onRowDragLeave(event: DragEvent, entry: VaultFileEntry): void;
  onRowDrop(event: DragEvent, entry: VaultFileEntry): void;
  onRootDragOver(event: DragEvent): void;
  onRootDrop(event: DragEvent): void;
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

describe('FilesPanel.onFileDragStart', () => {
  let host: DragStartHost;

  beforeEach(async () => {
    window.dreyApi = {
      getActiveVault: () => Promise.resolve(null),
      listVaultFiles: () => Promise.resolve([]),
    } as unknown as DreyApi;
    await TestBed.configureTestingModule({ imports: [FilesPanel] }).compileComponents();
    host = TestBed.createComponent(FilesPanel).componentInstance as unknown as DragStartHost;
  });

  afterEach(() => delete (window as { dreyApi?: unknown }).dreyApi);

  it('carries the vault path on the private + text/plain types for a file', () => {
    const dt = fakeDataTransfer();
    host.onFileDragStart({ dataTransfer: dt } as DragEvent, {
      name: 'logo.png',
      relativePath: 'assets/logo.png',
      type: 'file',
    });
    expect(dt.getData('application/x-drey-vault-path')).toBe('assets/logo.png');
    expect(dt.getData('text/plain')).toBe('assets/logo.png');
    expect(dt.effectAllowed).toBe('copyLink');
  });

  it('sets nothing for a directory', () => {
    const dt = fakeDataTransfer();
    host.onFileDragStart({ dataTransfer: dt } as DragEvent, {
      name: 'assets',
      relativePath: 'assets',
      type: 'directory',
    });
    expect(dt.getData('application/x-drey-vault-path')).toBe('');
  });
});

describe('FilesPanel keyboard navigation (bug-7)', () => {
  /** a.md · notes/ · notes/b.md -- three visible rows in display order. */
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

  beforeAll(() => {
    // jsdom implements focus() but not scrollIntoView; `select()` calls both.
    // Left in place for the whole file: `select()`'s setTimeout can escape a
    // synchronous test, and a deleted stub would turn that into an uncaught
    // error.
    Element.prototype.scrollIntoView = vi.fn();
  });

  beforeEach(async () => {
    window.dreyApi = {
      getActiveVault: () => Promise.resolve('C:/vault'),
      listVaultFiles: () => Promise.resolve(tree()),
    } as unknown as DreyApi;
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
      expect(rows().length).toBe(3);
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

  function clickRow(index: number, modifiers?: { shiftKey?: boolean; ctrlKey?: boolean }): void {
    rows()[index].dispatchEvent(new MouseEvent('click', { bubbles: true, ...modifiers }));
  }

  it('ArrowDown moves the selection AND DOM focus onto the new row', async () => {
    await renderTree();
    const host = fixture.componentInstance as unknown as SelectionHost;
    expect(host.selected()).toBeNull();

    pressKey('ArrowDown');
    expect(host.selected()).toBe('a.md');
    await settle();
    expect(document.activeElement).toBe(rows()[0]);

    pressKey('ArrowDown');
    expect(host.selected()).toBe('notes');
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

  it('Enter from the tree container opens the highlighted file', async () => {
    await renderTree();
    const editor = TestBed.inject(EditorService);
    const openFile = vi.spyOn(editor, 'openFile').mockResolvedValue(undefined);

    pressKey('ArrowDown'); // selection lands on a.md
    fixture.detectChanges();
    pressKey('Enter', treeScroll()); // container-focused branch (target === currentTarget)

    expect(openFile).toHaveBeenCalledWith('a.md');
    await settle(); // let select()'s focus timer fire inside the test
  });
});

describe('FilesPanel multi-select (bug-8)', () => {
  /** a.md · notes/ · notes/b.md -- three visible rows in display order. */
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
  let deleted: string[][];

  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  beforeEach(async () => {
    deleted = [];
    window.dreyApi = {
      getActiveVault: () => Promise.resolve('C:/vault'),
      listVaultFiles: () => Promise.resolve(tree()),
      deleteVaultEntries: (paths: string[]) => {
        deleted.push(paths);
        return Promise.resolve();
      },
    } as unknown as DreyApi;
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
      expect(rows().length).toBe(3);
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

    clickRow(0); // a.md, plain
    expect(host().selection()).toEqual(new Set(['a.md']));

    clickRow(2, { ctrlKey: true }); // notes/b.md joins
    expect(host().selection()).toEqual(new Set(['a.md', 'notes/b.md']));
    expect(host().selected()).toBe('notes/b.md');

    clickRow(2, { ctrlKey: true }); // toggles back out
    expect(host().selection()).toEqual(new Set(['a.md']));
    await settle();
  });

  it('Shift+click and Shift+ArrowDown extend a range over the visible rows', async () => {
    await renderTree();
    const editor = TestBed.inject(EditorService);
    vi.spyOn(editor, 'openFile').mockResolvedValue(undefined);

    clickRow(0); // anchor = a.md
    clickRow(2, { shiftKey: true }); // range a.md..notes/b.md
    expect(host().selection()).toEqual(new Set(['a.md', 'notes', 'notes/b.md']));

    // Fresh anchor, then keyboard extension.
    clickRow(0);
    pressKey('ArrowDown', { shiftKey: true });
    expect(host().selection()).toEqual(new Set(['a.md', 'notes']));
    await settle();
  });

  it('Ctrl+Arrow moves the cursor without changing the selection', async () => {
    await renderTree();
    pressKey('ArrowDown'); // cursor + selection = a.md
    pressKey('ArrowDown', { ctrlKey: true }); // cursor -> notes, selection stays
    expect(host().selected()).toBe('notes');
    expect(host().selection()).toEqual(new Set(['a.md']));
    await settle();
  });

  it('Enter opens every selected file once (folders skipped)', async () => {
    await renderTree();
    const editor = TestBed.inject(EditorService);
    const openFile = vi.spyOn(editor, 'openFile').mockResolvedValue(undefined);

    clickRow(0); // a.md (the plain click itself opens it)
    clickRow(2, { ctrlKey: true }); // notes/b.md joins
    openFile.mockClear(); // count only what Enter opens
    pressKey('Enter', undefined, treeScroll());

    await settle();
    const opened = openFile.mock.calls.map((call) => call[0]);
    expect(opened).toEqual(['a.md', 'notes/b.md']);
  });

  it('Delete removes the whole selection in ONE batched IPC call', async () => {
    await renderTree();
    const confirmDialog = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const closeTabsUnder = vi.spyOn(TestBed.inject(EditorService), 'closeTabsUnder');

    clickRow(0); // a.md
    clickRow(2, { ctrlKey: true }); // notes/b.md
    pressKey('Delete');

    await vi.waitFor(() => expect(deleted).toHaveLength(1));
    expect(deleted[0]).toEqual(['a.md', 'notes/b.md']);
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(closeTabsUnder).toHaveBeenCalledTimes(2);
    await settle();
  });

  it('Delete clears a clipboard entry that lived under a deleted folder', async () => {
    await renderTree();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const vault = TestBed.inject(VaultService);
    vault.clipboard.set({ path: 'notes/b.md', name: 'b.md' });

    clickRow(0); // a.md
    clickRow(2, { ctrlKey: true }); // notes/b.md
    pressKey('Delete');

    await vi.waitFor(() => expect(deleted).toHaveLength(1));
    expect(vault.clipboard()).toBeNull();
    await settle();
  });

  it('Escape collapses a multi-selection back to the cursor row', async () => {
    await renderTree();
    const editor = TestBed.inject(EditorService);
    vi.spyOn(editor, 'openFile').mockResolvedValue(undefined);

    clickRow(0);
    clickRow(2, { ctrlKey: true });
    expect(host().selection().size).toBe(2);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(host().selection()).toEqual(new Set(['notes/b.md'])); // the cursor row
    await settle();
  });
});

describe('FilesPanel drag & drop within the tree (req-23)', () => {
  /** a.md · notes/ · notes/b.md · archive/ -- four visible rows. */
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
  let renamed: Array<[string, string]>;

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
    window.dreyApi = {
      getActiveVault: () => Promise.resolve('C:/vault'),
      listVaultFiles: () => Promise.resolve(tree()),
      renameVaultEntry: (fromRel: string, toRel: string) => {
        renamed.push([fromRel, toRel]);
        return Promise.resolve(toRel);
      },
    } as unknown as DreyApi;
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
      expect(rows().length).toBe(4);
    });
  }

  it('a folder dragstart arms the move but sets no dataTransfer types', () => {
    const dt = fakeDataTransfer();
    host().onFolderDragStart({ dataTransfer: dt } as DragEvent, {
      name: 'notes',
      relativePath: 'notes',
      type: 'directory',
    });
    expect(dt.getData('application/x-drey-vault-path')).toBe('');
    expect(host().dragEntry()?.relativePath).toBe('notes');
    host().onDragEnd();
    expect(host().dragEntry()).toBeNull();
  });

  it('a file dragstart carries the editor-drop types AND arms the move', () => {
    const dt = fakeDataTransfer();
    host().onFileDragStart({ dataTransfer: dt } as DragEvent, {
      name: 'a.md',
      relativePath: 'a.md',
      type: 'file',
    });
    expect(dt.getData('application/x-drey-vault-path')).toBe('a.md');
    expect(host().dragEntry()?.relativePath).toBe('a.md');
  });

  it('dragover marks a valid folder target and leaves a no-op target untouched', async () => {
    await renderTree();
    const notes = { name: 'notes', relativePath: 'notes', type: 'directory' } as VaultFileEntry;
    const a = { name: 'a.md', relativePath: 'a.md', type: 'file' } as VaultFileEntry;
    host().onFileDragStart({ dataTransfer: fakeDataTransfer() } as DragEvent, a);

    const ontoNotes = dragEvent();
    host().onRowDragOver(ontoNotes.event, notes);
    expect(ontoNotes.prevented()).toBe(true); // drop allowed
    expect(host().dropHover()).toBe('notes');

    const ontoSelf = dragEvent(); // a.md onto a.md: same dir -> no-op
    host().onRowDragOver(ontoSelf.event, a);
    expect(ontoSelf.prevented()).toBe(false);
    expect(host().dropHover()).toBe('notes'); // unchanged
  });

  it('refuses a folder dropped into itself or its own subtree', async () => {
    await renderTree();
    const notes = { name: 'notes', relativePath: 'notes', type: 'directory' } as VaultFileEntry;
    const b = { name: 'b.md', relativePath: 'notes/b.md', type: 'file' } as VaultFileEntry;
    host().onFolderDragStart({ dataTransfer: fakeDataTransfer() } as DragEvent, notes);

    const ontoItself = dragEvent();
    host().onRowDragOver(ontoItself.event, notes); // dest 'notes' === dragged
    expect(ontoItself.prevented()).toBe(false);

    const intoChild = dragEvent(); // notes onto notes/b.md -> dest is 'notes' again
    host().onRowDragOver(intoChild.event, b);
    expect(intoChild.prevented()).toBe(false);
  });

  it('drop on a folder moves the file, retargets tabs, follows the clipboard', async () => {
    await renderTree();
    const editor = TestBed.inject(EditorService);
    const retarget = vi.spyOn(editor, 'retargetTabs');
    const vault = TestBed.inject(VaultService);
    vault.clipboard.set({ path: 'a.md', name: 'a.md' });

    host().onFileDragStart({ dataTransfer: fakeDataTransfer() } as DragEvent, {
      name: 'a.md',
      relativePath: 'a.md',
      type: 'file',
    });
    const drop = dragEvent();
    host().onRowDrop(drop.event, {
      name: 'notes',
      relativePath: 'notes',
      type: 'directory',
    });

    await vi.waitFor(() => expect(retarget).toHaveBeenCalledWith('a.md', 'notes/a.md'));
    expect(renamed).toEqual([['a.md', 'notes/a.md']]);
    expect(vault.clipboard()).toEqual({ path: 'notes/a.md', name: 'a.md' });
    expect(host().dragEntry()).toBeNull();
    expect(host().dropHover()).toBeNull();
    expect(drop.stopped()).toBe(true); // the root drop must not double-handle
  });

  it('drop on a file row targets the folder that file lives in', async () => {
    await renderTree();
    host().onFileDragStart({ dataTransfer: fakeDataTransfer() } as DragEvent, {
      name: 'a.md',
      relativePath: 'a.md',
      type: 'file',
    });
    host().onRowDrop(dragEvent().event, {
      name: 'b.md',
      relativePath: 'notes/b.md',
      type: 'file',
    });
    await vi.waitFor(() => expect(renamed).toEqual([['a.md', 'notes/a.md']]));
  });

  it('a collision alerts and leaves tabs and clipboard alone', async () => {
    await renderTree();
    window.dreyApi = {
      ...window.dreyApi,
      renameVaultEntry: () => Promise.reject(new Error('Already exists: notes/a.md')),
    } as unknown as DreyApi;
    const alertBox = vi.spyOn(window, 'alert').mockReturnValue(undefined);
    const retarget = vi.spyOn(TestBed.inject(EditorService), 'retargetTabs');

    host().onFileDragStart({ dataTransfer: fakeDataTransfer() } as DragEvent, {
      name: 'a.md',
      relativePath: 'a.md',
      type: 'file',
    });
    host().onRowDrop(dragEvent().event, {
      name: 'notes',
      relativePath: 'notes',
      type: 'directory',
    });

    await vi.waitFor(() => expect(alertBox).toHaveBeenCalled());
    expect(alertBox.mock.calls[0][0]).toContain('Already exists');
    expect(retarget).not.toHaveBeenCalled();
  });

  it('a root drop on the container background moves to the vault root', async () => {
    await renderTree();
    // `notes/b.md` is nested -- dragging it onto the root hoists it out.
    host().onFileDragStart({ dataTransfer: fakeDataTransfer() } as DragEvent, {
      name: 'b.md',
      relativePath: 'notes/b.md',
      type: 'file',
    });
    const over = dragEvent({ target: { closest: () => null } as unknown as EventTarget });
    host().onRootDragOver(over.event);
    expect(over.prevented()).toBe(true);

    const drop = dragEvent({ target: { closest: () => null } as unknown as EventTarget });
    host().onRootDrop(drop.event);
    await vi.waitFor(() => expect(renamed).toEqual([['notes/b.md', 'b.md']]));
    expect(drop.prevented()).toBe(true);
  });

  it('a top-level entry dropped on the root is a no-op, and a bubbled row drop never reaches it', async () => {
    await renderTree();
    host().onFileDragStart({ dataTransfer: fakeDataTransfer() } as DragEvent, {
      name: 'a.md',
      relativePath: 'a.md',
      type: 'file',
    });
    const rootDrop = dragEvent({ target: { closest: () => null } as unknown as EventTarget });
    host().onRootDrop(rootDrop.event); // a.md is already at the root
    expect(rootDrop.prevented()).toBe(false);
    expect(renamed).toEqual([]);

    // A drop on a row bubbles to the container -- the `.node` guard ignores it.
    const bubbled = dragEvent({ target: { closest: () => ({}) } as unknown as EventTarget });
    host().onRootDrop(bubbled.event);
    expect(renamed).toEqual([]);
  });
});

