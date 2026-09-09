import { TestBed } from '@angular/core/testing';
import { KeybindingService } from '../keybindings';
import { WidgetContext } from './widget-context';

describe('WidgetContext', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
  });

  it('injects and exposes the active-document / tree / query surface', () => {
    const ctx = TestBed.inject(WidgetContext);
    // No vault, no open tab in a bare TestBed.
    expect(ctx.activeDocumentPath()).toBeNull();
    expect(ctx.activeDocumentName()).toBeNull();
    expect(ctx.activeDocumentDirty()).toBe(false);
    expect(ctx.fileTree()).toEqual([]);
    expect(ctx.activeVaultPath()).toBeNull();
    expect(ctx.tags()).toEqual([]);
    expect(ctx.selection()).toBeNull();
  });

  it('resolves the query methods to empty results without a backend', async () => {
    const ctx = TestBed.inject(WidgetContext);
    await expect(ctx.searchSections({ tags: [], text: '' })).resolves.toEqual([]);
    await expect(ctx.listTasks()).resolves.toEqual([]);
    expect(typeof ctx.onVaultChanged(() => {})).toBe('function');
  });

  it('forwards command registration to the keybinding registry', () => {
    const ctx = TestBed.inject(WidgetContext);
    const keys = TestBed.inject(KeybindingService);
    ctx.registerCommand({ id: 'widget.demo', label: 'Demo', run: () => {} });
    expect(keys.all().some((c) => c.id === 'widget.demo')).toBe(true);
  });
});
