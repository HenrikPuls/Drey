import { TestBed } from '@angular/core/testing';
import { DocKindRegistry } from '../plugin-host';
import { EditorService } from '../services/editor.service';
import { SettingsService } from '../services/settings.service';
import { SETTINGS_DOC_KEY, SETTINGS_DOC_KIND } from './settings-doc';
import { SettingsTabService } from './settings-tab.service';

describe('SettingsTabService (board 7g: Settings is an editor tab)', () => {
  const addPluginDoc = vi.fn();
  const openCategory = { set: vi.fn() };

  beforeEach(() => {
    addPluginDoc.mockClear();
    openCategory.set.mockClear();
    TestBed.configureTestingModule({
      providers: [
        { provide: EditorService, useValue: { addPluginDoc } },
        { provide: SettingsService, useValue: { openCategory } },
      ],
    });
  });

  it('registers the core doc kind: title "Settings", nothing but its presence in the session', () => {
    const tab = TestBed.inject(SettingsTabService);
    const kind = TestBed.inject(DocKindRegistry).get(SETTINGS_DOC_KIND)!;
    expect(kind.serialize(SETTINGS_DOC_KEY)).toBeNull();
    expect(kind.statusText?.(SETTINGS_DOC_KEY)).toBe('Settings');
    kind.restore(SETTINGS_DOC_KEY, null);
    expect(addPluginDoc).toHaveBeenCalledWith('settings', 'settings://', 'Settings');
    expect(tab).toBeTruthy();
  });

  it('opens one tab under one key, optionally on a page', () => {
    const tab = TestBed.inject(SettingsTabService);
    tab.open();
    tab.open('about');
    expect(addPluginDoc).toHaveBeenCalledTimes(2);
    expect(addPluginDoc.mock.calls.every(([kind, key]) => kind === 'settings' && key === 'settings://')).toBe(true);
    expect(openCategory.set).toHaveBeenCalledWith('about');
  });
});
