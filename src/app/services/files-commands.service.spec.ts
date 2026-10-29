import { TestBed } from '@angular/core/testing';
import type { FilesContextMenuTarget } from '../../../shared/plugin-api/renderer';
import { FilesCommandsService } from './files-commands.service';

const vaultRow: FilesContextMenuTarget = {
  vaultId: 'tickets',
  vaultName: 'Tickets',
  path: '',
  type: 'directory',
};

const folderRow = (path: string): FilesContextMenuTarget => ({
  vaultId: 'tickets',
  vaultName: 'Tickets',
  path,
  type: 'directory',
});

describe('FilesCommandsService (SDK 1.32 files context rows)', () => {
  let service: FilesCommandsService;

  beforeEach(() => {
    service = TestBed.inject(FilesCommandsService);
  });

  it('yields nothing when no plugin contributed', () => {
    expect(service.itemsFor(vaultRow)).toEqual([]);
  });

  it('concatenates rows in registration order', () => {
    service.register('a', () => [{ label: 'A1', run: () => undefined }]);
    service.register('b', () => [
      { label: 'B1', run: () => undefined },
      { label: 'B2', run: () => undefined },
    ]);
    const labels = service.itemsFor(vaultRow).map((item) => item.label);
    expect(labels).toEqual(['A1', 'B1', 'B2']);
  });

  it('the callback is re-evaluated per open (rows can change between calls)', () => {
    let removed = false;
    service.register('tickets', (target) =>
      target.type === 'directory' && !removed ? [{ label: 'Remove', run: () => undefined }] : [],
    );
    expect(service.itemsFor(folderRow('_worktrees/T-0044'))).toHaveLength(1);
    removed = true;
    expect(service.itemsFor(folderRow('_worktrees/T-0044'))).toEqual([]);
  });

  it('the callback receives the menu target', () => {
    const seen: FilesContextMenuTarget[] = [];
    service.register('tickets', (target) => {
      seen.push(target);
      return [];
    });
    service.itemsFor(folderRow('tickets/archive'));
    expect(seen).toEqual([folderRow('tickets/archive')]);
  });

  it('a throwing contributor contributes nothing, others still do', () => {
    service.register('broken', () => {
      throw new Error('boom');
    });
    service.register('ok', () => [{ label: 'OK', run: () => undefined }]);
    expect(service.itemsFor(vaultRow).map((item) => item.label)).toEqual(['OK']);
  });

  it('clear drops one plugin; unsubscribe keeps a newer registration', () => {
    const off = service.register('tickets', () => [{ label: 'old', run: () => undefined }]);
    service.register('tickets', () => [{ label: 'new', run: () => undefined }]);
    off();
    expect(service.itemsFor(vaultRow).map((item) => item.label)).toEqual(['new']);
    service.clear('tickets');
    expect(service.itemsFor(vaultRow)).toEqual([]);
  });
});
