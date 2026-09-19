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

  it('decide maps Save / Don\'t save / Cancel (and Escape) onto a SaveDecision', async () => {
    const save = service.decide({ message: 'Save a.md?' });
    expect(service.current()).toMatchObject({
      confirmLabel: 'Save',
      discardLabel: "Don't save",
      cancelLabel: 'Cancel',
    });
    service.accept();
    await expect(save).resolves.toBe('save');

    const discard = service.decide({ message: 'Save b.md?' });
    service.discard();
    await expect(discard).resolves.toBe('discard');

    const cancel = service.decide({ message: 'Save c.md?' });
    service.cancel(); // also what Escape / the backdrop call
    await expect(cancel).resolves.toBe('cancel');
  });

  it('a plain confirm never offers the middle button', () => {
    void service.confirm({ message: 'Delete?' });
    expect(service.current()?.discardLabel).toBeNull();
    service.cancel();
  });

  it('cancel with nothing pending is a no-op (the always-attached Escape host listener)', () => {
    expect(() => service.cancel()).not.toThrow();
    expect(service.current()).toBeNull();
  });
});
