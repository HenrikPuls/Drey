import { describe, expect, it, vi } from 'vitest';
import { removeEntryFromDisk, TrashIo } from './trash-delete';

function makeIo(): TrashIo & { trashItem: ReturnType<typeof vi.fn>; rm: ReturnType<typeof vi.fn> } {
  const trashItem = vi.fn(async (): Promise<void> => undefined);
  const rm = vi.fn(async (): Promise<void> => undefined);
  return { trashItem, rm };
}

describe('removeEntryFromDisk', () => {
  it('moves to the recycle bin by default and never rms', async () => {
    const io = makeIo();
    await expect(removeEntryFromDisk('C:/vault/note.md', undefined, io)).resolves.toBe('trashed');
    expect(io.trashItem).toHaveBeenCalledWith('C:/vault/note.md');
    expect(io.trashItem).toHaveBeenCalledTimes(1);
    expect(io.rm).not.toHaveBeenCalled();
  });

  it('honours an explicit trash: true', async () => {
    const io = makeIo();
    await expect(removeEntryFromDisk('C:/vault/folder', { trash: true }, io)).resolves.toBe('trashed');
    expect(io.rm).not.toHaveBeenCalled();
  });

  it('falls back to the permanent rm when the recycle bin is unavailable', async () => {
    const io = makeIo();
    io.trashItem.mockRejectedValue(new Error('FAILED_DELETE_UNTO_TRASH'));
    await expect(removeEntryFromDisk('//share/note.md', undefined, io)).resolves.toBe('removed');
    expect(io.rm).toHaveBeenCalledWith('//share/note.md');
  });

  it('never touches the recycle bin for move semantics (trash: false)', async () => {
    const io = makeIo();
    await expect(removeEntryFromDisk('C:/vault/.drafts/x.md', { trash: false }, io)).resolves.toBe('removed');
    expect(io.trashItem).not.toHaveBeenCalled();
    expect(io.rm).toHaveBeenCalledTimes(1);
  });

  it('propagates a real rm failure', async () => {
    const io = makeIo();
    io.trashItem.mockRejectedValue(new Error('no bin'));
    io.rm.mockRejectedValue(new Error('EBUSY'));
    await expect(removeEntryFromDisk('C:/vault/note.md', undefined, io)).rejects.toThrow('EBUSY');
  });
});
