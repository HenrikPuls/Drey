import { TestBed } from '@angular/core/testing';
import { DreyApi, VaultFileEntry } from '../../../../shared/ipc-api';
import { FilesPanel } from './files-panel';

/** The `dragstart` handler is `protected`; reach it through a cast. */
type DragStartHost = { onFileDragStart(event: DragEvent, entry: VaultFileEntry): void };

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
