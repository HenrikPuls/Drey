import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Sidebar } from './sidebar';
import { CyberNotesApi, VaultFileEntry } from '../../../shared/ipc-api';

describe('Sidebar', () => {
  let component: Sidebar;
  let fixture: ComponentFixture<Sidebar>;

  const fakeTree: VaultFileEntry[] = [
    {
      name: 'sailing',
      relativePath: 'sailing',
      type: 'directory',
      children: [{ name: '_index.md', relativePath: 'sailing/_index.md', type: 'file' }],
    },
  ];

  beforeEach(async () => {
    const fakeApi: Partial<CyberNotesApi> = {
      getActiveVault: () => Promise.resolve('E:/vault'),
      listVaultFiles: () => Promise.resolve(fakeTree),
    };
    window.cyberNotesApi = fakeApi as CyberNotesApi;

    await TestBed.configureTestingModule({
      imports: [Sidebar],
    }).compileComponents();

    fixture = TestBed.createComponent(Sidebar);
    component = fixture.componentInstance;
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    delete (window as { cyberNotesApi?: unknown }).cyberNotesApi;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('renders the nested file tree', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const names = Array.from(compiled.querySelectorAll('.entry-name')).map((el) => el.textContent);
    expect(names).toEqual(['sailing', '_index.md']);
  });

  it('selects a file entry on click but ignores directory clicks', () => {
    const [directoryEntry, fileEntry] = fakeTree[0].children
      ? [fakeTree[0], fakeTree[0].children[0]]
      : [fakeTree[0], fakeTree[0]];

    component['onEntryClick'](directoryEntry);
    expect(component['selectedPath']()).toBeNull();

    component['onEntryClick'](fileEntry);
    expect(component['selectedPath']()).toBe('sailing/_index.md');
  });
});
