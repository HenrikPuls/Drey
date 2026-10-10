import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { RenameLinksPreview, RenameLinksResult } from '../../../shared/ipc-api';
import { ConfirmDialogService } from '../services/confirm-dialog.service';
import { EditorService } from '../services/editor.service';
import { SettingsService } from '../services/settings.service';
import { VaultService } from '../vault';
import { LinkUpdateService } from './link-update.service';

const PREVIEW: RenameLinksPreview = {
  files: [{ path: 'a.md', newPath: 'a.md', links: 1, before: '[[Old]]', after: '[[New]]' }],
  assets: [],
};

const RESULT: RenameLinksResult = {
  path: 'New.md',
  written: ['a.md'],
  buffers: [{ path: 'dirty.md', content: '[[New]] edited' }],
  assets: [{ kind: 'move', from: 'attachments/x.png', to: 'sub/attachments/x.png' }],
  failed: [],
};

describe('LinkUpdateService', () => {
  let service: LinkUpdateService;
  const mode = signal<'ask' | 'always' | 'never'>('ask');
  const vault = {
    previewRename: vi.fn(),
    renameWithLinks: vi.fn(),
    renameEntry: vi.fn(),
  };
  const editor = {
    openDocs: signal([
      {
        kind: 'text',
        vaultId: 'v1',
        path: 'dirty.md',
        existsOnDisk: true,
        savedContent: '[[Old]]',
        bufferContent: '[[Old]] edited',
      },
      { kind: 'text', vaultId: 'v1', path: 'clean.md', existsOnDisk: true, savedContent: 'x', bufferContent: 'x' },
      { kind: 'text', vaultId: 'v2', path: 'far.md', existsOnDisk: true, savedContent: 'x', bufferContent: 'y' },
    ]),
    retargetTabs: vi.fn(),
    updateBuffer: vi.fn(),
    reloadFromVaultChange: vi.fn().mockResolvedValue(undefined),
  };
  const settings = {
    config: () => ({ vault: { updateLinksOnRename: mode() } }),
    setUpdateLinksOnRename: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mode.set('ask');
    vault.previewRename.mockResolvedValue(PREVIEW);
    vault.renameWithLinks.mockResolvedValue(RESULT);
    vault.renameEntry.mockResolvedValue('New.md');
    TestBed.configureTestingModule({
      providers: [
        { provide: VaultService, useValue: vault },
        { provide: EditorService, useValue: editor },
        { provide: SettingsService, useValue: settings },
        { provide: ConfirmDialogService, useValue: { message: vi.fn() } },
      ],
    });
    service = TestBed.inject(LinkUpdateService);
  });

  /** Answers the dialog as soon as the preview has put it up. */
  async function answerWhenAsked(choice: 'update' | 'rename' | 'cancel', dontAsk = false): Promise<void> {
    await vi.waitFor(() => expect(service.pending()).not.toBeNull());
    service.answer(choice, dontAsk);
  }

  it('never: renames without looking for links', async () => {
    mode.set('never');
    expect(await service.rename('v1', 'Old.md', 'v1', 'New.md')).toBe('New.md');
    expect(vault.previewRename).not.toHaveBeenCalled();
    expect(vault.renameEntry).toHaveBeenCalledWith('Old.md', 'New.md', 'v1', 'v1');
    expect(editor.retargetTabs).toHaveBeenCalledWith('v1::Old.md', 'v1::New.md');
  });

  it('skips the dialog when nothing would change', async () => {
    vault.previewRename.mockResolvedValue({ files: [], assets: [] });
    expect(await service.rename('v1', 'Old.md', 'v1', 'New.md')).toBe('New.md');
    expect(service.pending()).toBeNull();
    expect(vault.renameWithLinks).not.toHaveBeenCalled();
    expect(vault.renameEntry).toHaveBeenCalled();
  });

  it('ask + update: hands dirty notes over as buffers and patches them in place', async () => {
    const done = service.rename('v1', 'Old.md', 'v1', 'New.md');
    await answerWhenAsked('update');
    expect(await done).toBe('New.md');

    const request = vault.renameWithLinks.mock.calls[0][0];
    expect(request.buffers).toEqual([{ path: 'dirty.md', content: '[[Old]] edited' }]);
    expect(editor.retargetTabs).toHaveBeenCalledWith('v1::Old.md', 'v1::New.md');
    expect(editor.retargetTabs).toHaveBeenCalledWith('v1::attachments/x.png', 'v1::sub/attachments/x.png');
    expect(editor.updateBuffer).toHaveBeenCalledWith('v1::dirty.md', '[[New]] edited');
    expect(editor.reloadFromVaultChange).toHaveBeenCalledWith('v1', ['a.md']);
    expect(settings.setUpdateLinksOnRename).not.toHaveBeenCalled();
  });

  it('ask + cancel: renames nothing', async () => {
    const done = service.rename('v1', 'Old.md', 'v1', 'New.md');
    await answerWhenAsked('cancel', true);
    expect(await done).toBeNull();
    expect(vault.renameEntry).not.toHaveBeenCalled();
    expect(vault.renameWithLinks).not.toHaveBeenCalled();
    expect(settings.setUpdateLinksOnRename).not.toHaveBeenCalled();
  });

  it('"rename only" with don\'t-ask-again persists never', async () => {
    const done = service.rename('v1', 'Old.md', 'v1', 'New.md');
    await answerWhenAsked('rename', true);
    expect(await done).toBe('New.md');
    expect(vault.renameWithLinks).not.toHaveBeenCalled();
    expect(settings.setUpdateLinksOnRename).toHaveBeenCalledWith('never');
  });

  it('always: updates without asking', async () => {
    mode.set('always');
    expect(await service.rename('v1', 'Old.md', 'v1', 'New.md')).toBe('New.md');
    expect(service.pending()).toBeNull();
    expect(vault.renameWithLinks).toHaveBeenCalled();
  });
});
