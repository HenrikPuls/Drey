import { TestBed } from '@angular/core/testing';
import { ConfirmDialogService } from './confirm-dialog.service';

describe('ConfirmDialogService', () => {
  let service: ConfirmDialogService;

  beforeEach(() => {
    service = TestBed.inject(ConfirmDialogService);
  });

  it('confirm resolves true on accept and false on cancel', async () => {
    const first = service.confirm({ message: 'Delete "a.md"?', confirmLabel: 'Delete' });
    expect(service.current()?.message).toBe('Delete "a.md"?');

    service.accept();
    await expect(first).resolves.toBe(true);
    expect(service.current()).toBeNull();

    const second = service.confirm({ message: 'Remove vault?' });
    service.cancel();
    await expect(second).resolves.toBe(false);
  });

  it('queues a second dialog and answers it after the first settles', async () => {
    const outcomes: string[] = [];
    const first = service.confirm({ message: 'first' }).then((v) => {
      outcomes.push(`first:${v}`);
      return v;
    });
    const second = service.message({ message: 'second' }).then(() => outcomes.push('second'));

    expect(service.current()?.message).toBe('first');
    service.accept();
    await first;
    // Accepting the first pulled the queued message dialog; answer it too.
    expect(service.current()?.message).toBe('second');
    service.accept();
    await second;

    expect(outcomes).toEqual(['first:true', 'second']);
    expect(service.current()).toBeNull();
  });

  it('message() shows an OK-only dialog (no cancel button state)', async () => {
    const shown = service.message({ message: 'boom' });
    expect(service.current()).toMatchObject({
      message: 'boom',
      cancelLabel: null,
      confirmLabel: 'OK',
    });
    service.accept();
    await shown;
  });

  it('cancel with nothing pending is a no-op (the always-attached Escape host listener)', () => {
    expect(() => service.cancel()).not.toThrow();
    expect(service.current()).toBeNull();
  });
});
