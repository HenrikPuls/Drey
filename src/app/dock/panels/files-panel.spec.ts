import { TestBed, ComponentFixture } from '@angular/core/testing';
import { DreyApi, VaultFileEntry } from '../../../../shared/ipc-api';
import { EditorService } from '../../services/editor.service';
import { FilesPanel } from './files-panel';

/** The `dragstart` handler is `protected`; reach it through a cast. */
type DragStartHost = { onFileDragStart(event: DragEvent, entry: VaultFileEntry): void };

/** The keyboard selection is `protected` too. */
type SelectionHost = { selected(): string | null };

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

  function pressKey(key: string, target?: HTMLElement): void {
    (target ?? treeScroll()).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true }),
    );
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
