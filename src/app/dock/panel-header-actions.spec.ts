import { Component, TemplateRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { PanelHeaderActions, PanelHeaderActionsStore } from './panel-header-actions';

describe('PanelHeaderActionsStore', () => {
  it('set / get / clear a template by id', () => {
    const store = new PanelHeaderActionsStore();
    const a = {} as TemplateRef<unknown>;
    const b = {} as TemplateRef<unknown>;

    expect(store.get('tasks')).toBeNull();
    store.set('tasks', a);
    expect(store.get('tasks')).toBe(a);

    // A later panel-move registers its own template before the old one's
    // destroy hook runs -- clearing with the stale ref must be a no-op.
    store.set('tasks', b);
    store.clear('tasks', a);
    expect(store.get('tasks')).toBe(b);

    store.clear('tasks', b);
    expect(store.get('tasks')).toBeNull();
  });
});

@Component({
  selector: 'test-host',
  imports: [PanelHeaderActions],
  template: `
    @if (mounted()) {
      <ng-template appPanelHeaderActions="tasks"><span>x</span></ng-template>
    }
  `,
})
class Host {
  readonly mounted = signal(true);
}

describe('PanelHeaderActions directive', () => {
  it('registers its template with the store while mounted and clears on destroy', async () => {
    const fixture = TestBed.createComponent(Host);
    const store = TestBed.inject(PanelHeaderActionsStore);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(store.get('tasks')).not.toBeNull();

    fixture.componentInstance.mounted.set(false);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(store.get('tasks')).toBeNull();
  });
});
