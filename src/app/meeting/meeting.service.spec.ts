import { TestBed } from '@angular/core/testing';
import type { DreyApi } from '../../../shared/ipc-api';
import { EditorService } from '../services/editor.service';
import { MeetingService } from './meeting.service';

describe('MeetingService', () => {
  let service: MeetingService;
  let editor: EditorService;
  const originalApi = window.dreyApi;

  afterEach(() => {
    window.dreyApi = originalApi;
  });

  function setup(api: Partial<DreyApi>): void {
    window.dreyApi = api as unknown as DreyApi;
    service = TestBed.inject(MeetingService);
    editor = TestBed.inject(EditorService);
  }

  describe('decodeToMarkdown', () => {
    it('rejects when the desktop bridge is missing', async () => {
      setup({});
      await expect(service.decodeToMarkdown(new Uint8Array([1]), 'x.ics')).rejects.toThrow(
        /desktop app/i,
      );
    });

    it('forwards the exact bytes and filename and returns the section', async () => {
      const seen: Array<{ bytes: Uint8Array; filename: string }> = [];
      setup({
        decodeMeeting: (bytes: Uint8Array, filename: string) => {
          seen.push({ bytes, filename });
          return Promise.resolve('## 📅 Sync\n\n#mtg/sync');
        },
      });
      const bytes = new Uint8Array([9, 8, 7]);
      const out = await service.decodeToMarkdown(bytes, 'invite.ics');
      expect(out).toContain('#mtg/sync');
      expect(seen).toEqual([{ bytes, filename: 'invite.ics' }]);
    });
  });

  describe('importIntoNote', () => {
    it('does nothing when the picker is cancelled', async () => {
      const insert = vi.fn();
      setup({ importMeeting: () => Promise.resolve(null) });
      vi.spyOn(editor, 'requestInsertText').mockImplementation(insert);
      await service.importIntoNote();
      expect(insert).not.toHaveBeenCalled();
    });

    it('inserts the returned section at the caret', async () => {
      const insert = vi.fn();
      setup({ importMeeting: () => Promise.resolve('## 📅 Sync\n\n#mtg/sync') });
      vi.spyOn(editor, 'requestInsertText').mockImplementation(insert);
      await service.importIntoNote();
      expect(insert).toHaveBeenCalledWith('## 📅 Sync\n\n#mtg/sync');
    });

    it('surfaces a decode error on the editor error signal', async () => {
      setup({ importMeeting: () => Promise.reject(new Error('The invite has no event in it.')) });
      await service.importIntoNote();
      expect(editor.error()).toBe('The invite has no event in it.');
    });
  });
});
