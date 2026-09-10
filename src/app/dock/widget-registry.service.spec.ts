import { TestBed } from '@angular/core/testing';
import { WidgetRegistryService } from './widget-registry.service';
import { CORE_WIDGETS } from './widget-registry';

describe('WidgetRegistryService', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
  });

  it('exposes the core widgets', () => {
    const registry = TestBed.inject(WidgetRegistryService);
    expect(registry.widgets().map((w) => w.id)).toEqual(CORE_WIDGETS.map((w) => w.id));
  });

  it('registers a plugin widget and exposes it through the derived views', () => {
    const registry = TestBed.inject(WidgetRegistryService);
    const unsubscribe = registry.registerPluginWidget({
      id: 'spec',
      title: 'Spec',
      defaultDock: 'left',
      defaultOpen: true,
      defaultFlex: 100,
      mount: () => () => undefined,
    });
    expect(registry.widgets().map((w) => w.id)).toContain('spec');
    expect(registry.isPlugin('spec')).toBe(true);
    expect(registry.contribFor('spec')?.title).toBe('Spec');
    unsubscribe();
    expect(registry.isPlugin('spec')).toBe(false);
    expect(registry.widgets().map((w) => w.id)).toEqual(CORE_WIDGETS.map((w) => w.id));
  });

  it('refuses a plugin widget id that collides with a core widget', () => {
    const registry = TestBed.inject(WidgetRegistryService);
    expect(() =>
      registry.registerPluginWidget({
        id: 'calendar',
        title: 'Impostor',
        defaultDock: 'left',
        defaultOpen: true,
        defaultFlex: 100,
        mount: () => () => undefined,
      } as never),
    ).toThrowError(/collides with a core widget/);
  });

  it('refuses a duplicate plugin widget id', () => {
    const registry = TestBed.inject(WidgetRegistryService);
    const register = (): void => {
      registry.registerPluginWidget({
        id: 'dup',
        title: 'Dup',
        defaultDock: 'left',
        defaultOpen: true,
        defaultFlex: 100,
        mount: () => () => undefined,
      });
    };
    register();
    expect(register).toThrowError(/already registered by a plugin/);
  });
});
