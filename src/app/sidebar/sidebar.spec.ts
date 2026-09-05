import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Sidebar } from './sidebar';
import { EditorService } from '../services/editor.service';
import { DreyApi, VaultFileEntry } from '../../../shared/ipc-api';

describe('Sidebar', () => {
  let component: Sidebar;
  let fixture: ComponentFixture<Sidebar>;
  let editor: EditorService;

  const fakeTree: VaultFileEntry[] = [
    {
      name: 'sailing',
      relativePath: 'sailing',
      type: 'directory',
      children: [{ name: '_index.md', relativePath: 'sailing/_index.md', type: 'file' }],
    },
  ];

  let created: Array<{ kind: string; path: string }>;

  beforeEach(async () => {
    created = [];
    const fakeApi: Partial<DreyApi> = {
      getActiveVault: () => Promise.resolve('E:/vault'),
      listVaultFiles: () => Promise.resolve(fakeTree),
      readVaultFile: () => Promise.resolve({ content: '# Index', modifiedMs: 1 }),
      createVaultFile: (path: string) => {
        created.push({ kind: 'file', path });
        return Promise.resolve(path);
      },
      createVaultDirectory: (path: string) => {
        created.push({ kind: 'directory', path });
        return Promise.resolve(path);
      },
    };
    window.dreyApi = fakeApi as DreyApi;

    await TestBed.configureTestingModule({ imports: [Sidebar] }).compileComponents();

    fixture = TestBed.createComponent(Sidebar);
    component = fixture.componentInstance;
    editor = TestBed.inject(EditorService);
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('renders the nested file tree', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const names = Array.from(compiled.querySelectorAll('.node-name')).map((el) => el.textContent);
    expect(names).toEqual(['sailing', '_index.md']);
  });

  it('creates a file from the context menu, in the right-clicked folder', async () => {
    const folder = (fixture.nativeElement as HTMLElement).querySelector(
      '.node.folder',
    ) as HTMLButtonElement;
    folder.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }),
    );
    fixture.detectChanges();

    const items = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
      '.ctx-menu button',
    );
    expect(items.length).toBe(2);
    items[0].click(); // "New file"
    fixture.detectChanges();

    const input = (fixture.nativeElement as HTMLElement).querySelector(
      '.create-input',
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    input.value = 'ideas';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await fixture.whenStable();

    expect(created).toEqual([{ kind: 'file', path: 'sailing/ideas.md' }]);
    expect(editor.openPath()).toBe('sailing/ideas.md');
  });

  it('creates a folder at the vault root from an empty-area right-click', async () => {
    const files = (fixture.nativeElement as HTMLElement).querySelector('.files') as HTMLElement;
    files.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
    fixture.detectChanges();

    const items = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
      '.ctx-menu button',
    );
    items[1].click(); // "New folder"
    fixture.detectChanges();

    const input = (fixture.nativeElement as HTMLElement).querySelector(
      '.create-input',
    ) as HTMLInputElement;
    input.value = 'trips';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await fixture.whenStable();

    expect(created).toEqual([{ kind: 'directory', path: 'trips' }]);
  });

  it('collapses and re-expands a folder on click', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const folder = compiled.querySelector('.node.folder') as HTMLButtonElement;

    folder.click();
    fixture.detectChanges();
    expect(compiled.querySelectorAll('.node.file').length).toBe(0);

    folder.click();
    fixture.detectChanges();
    expect(compiled.querySelectorAll('.node.file').length).toBe(1);
  });

  it('opens a file entry on click but ignores directory clicks', async () => {
    component['onFileClick'](fakeTree[0]);
    await fixture.whenStable();
    expect(editor.openPath()).toBeNull();

    component['onFileClick'](fakeTree[0].children![0]);
    await fixture.whenStable();
    expect(editor.openPath()).toBe('sailing/_index.md');
  });
});
