import { TestBed } from '@angular/core/testing';
import { TitlebarActionsService } from './titlebar-actions.service';

describe('TitlebarActionsService', () => {
  it('lists a registered action, with its icon when the host has it, until it is removed', () => {
    const svc = TestBed.inject(TitlebarActionsService);
    const remove = svc.register({ label: 'Capture', icon: 'mic', commandId: 'a.capture' });
    svc.register({ label: 'Other', icon: 'no-such-icon', commandId: 'a.other' });
    expect(svc.actions().map((a) => [a.spec.label, a.icon])).toEqual([
      ['Capture', 'mic'],
      ['Other', null],
    ]);
    remove();
    expect(svc.actions().map((a) => a.spec.label)).toEqual(['Other']);
  });
});
