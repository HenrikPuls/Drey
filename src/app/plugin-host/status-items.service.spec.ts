import { TestBed } from '@angular/core/testing';
import { StatusItemsService } from './status-items.service';

describe('StatusItemsService', () => {
  let svc: StatusItemsService;
  beforeEach(() => {
    svc = TestBed.inject(StatusItemsService);
  });

  it('orders by priority (high first), then registration order', () => {
    svc.create({ text: 'a' });
    svc.create({ text: 'b', priority: 5 });
    svc.create({ text: 'c' });
    expect(svc.items().map((i) => i.spec.text)).toEqual(['b', 'a', 'c']);
  });

  it('update merges fields and dispose removes', () => {
    const h = svc.create({ text: 'x', tooltip: 't' });
    h.update({ text: 'y' });
    expect(svc.items()[0].spec).toEqual({ text: 'y', tooltip: 't' });
    h.dispose();
    expect(svc.items()).toEqual([]);
  });

  it('hides an item with neither text nor icon', () => {
    const h = svc.create({ text: 'x' });
    h.update({ text: '' });
    expect(svc.items()).toEqual([]);
    h.update({ icon: 'settings' });
    expect(svc.items().length).toBe(1);
  });
});
