import { TestBed } from '@angular/core/testing';
import { AppConfig, normalizeAppConfig } from '../../../shared/app-config';
import { DreyApi } from '../../../shared/ipc-api';
import { SettingsService } from './settings.service';

/**
 * A stand-in for the main process: `setConfig` runs the real
 * `normalizeAppConfig`, exactly like `AppConfigStore` does, so the tests
 * exercise the true round-trip shape.
 */
function fakeApi(): { api: Partial<DreyApi>; stored: () => AppConfig; setCalls: () => number } {
  let disk = normalizeAppConfig({});
  let calls = 0;
  return {
    api: {
      getConfig: () => Promise.resolve(structuredClone(disk)),
      setConfig: (config: AppConfig) => {
        calls++;
        disk = normalizeAppConfig(config);
        return Promise.resolve(structuredClone(disk));
      },
    },
    stored: () => disk,
    setCalls: () => calls,
  };
}

describe('SettingsService (draft model)', () => {
  let service: SettingsService;
  let harness: ReturnType<typeof fakeApi>;

  beforeEach(async () => {
    harness = fakeApi();
    window.dreyApi = harness.api as DreyApi;
    service = TestBed.inject(SettingsService);
    await service.load();
    service.openScreen();
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  it('starts with a draft equal to the persisted config and not dirty', () => {
    expect(service.draft()).toEqual(service.config());
    expect(service.isDirty()).toBe(false);
  });

  it('keeps an edit in the draft and off disk until save', () => {
    service.patchLlm({ apiKey: 'sk-unsloth-abc' });

    expect(service.draft()?.llm.apiKey).toBe('sk-unsloth-abc');
    expect(service.config()?.llm.apiKey).toBeNull();
    expect(service.isDirty()).toBe(true);
    expect(harness.setCalls()).toBe(0); // no IPC per keystroke
  });

  it('does not round-trip through IPC while typing (the key survives every keystroke)', () => {
    for (const partial of ['s', 'sk', 'sk-', 'sk-u', 'sk-unsloth-KEY']) {
      service.patchLlm({ apiKey: partial });
      expect(service.draft()?.llm.apiKey).toBe(partial);
    }
    expect(harness.setCalls()).toBe(0);
  });

  it('persists the whole draft on save and clears the dirty flag', async () => {
    service.patchLlm({
      enabled: true,
      baseUrl: 'http://127.0.0.1:8888/v1',
      apiKey: 'sk-unsloth-KEY',
      model: 'Bonsai-27B-GGUF',
    });

    expect(await service.save()).toBe(true);

    expect(harness.stored().llm).toEqual({
      enabled: true,
      baseUrl: 'http://127.0.0.1:8888/v1',
      apiKey: 'sk-unsloth-KEY',
      model: 'Bonsai-27B-GGUF',
    });
    expect(service.config()?.llm.apiKey).toBe('sk-unsloth-KEY');
    expect(service.isDirty()).toBe(false);
  });

  it('trims a pasted key on save (values are stored verbatim while typing)', async () => {
    service.patchLlm({ apiKey: '  sk-unsloth-KEY  ' });
    expect(service.draft()?.llm.apiKey).toBe('  sk-unsloth-KEY  ');

    await service.save();
    expect(service.config()?.llm.apiKey).toBe('sk-unsloth-KEY');
  });

  it('discard throws the draft away and leaves disk untouched', () => {
    service.patchLlm({ apiKey: 'sk-nope' });
    service.discard();

    expect(service.isDirty()).toBe(false);
    expect(service.draft()?.llm.apiKey).toBeNull();
    expect(harness.setCalls()).toBe(0);
  });

  it('runtime state reads the persisted config, never the draft', async () => {
    service.patchLlm({ enabled: true });
    expect(service.llmEnabled()).toBe(false); // unsaved -- Ask must stay off

    await service.save();
    expect(service.llmEnabled()).toBe(true);
  });

  it('patchDaily / patchTemplates write the draft only, and getters read the persisted config', async () => {
    expect(service.loaded()).toBe(true);
    expect(service.dailyOpenOnStartup()).toBe(true);
    expect(service.templatesDir()).toBe('templates');

    service.patchDaily({ openOnStartup: false });
    service.patchTemplates({ dir: 'snippets' });
    // Draft moved; persisted getters unchanged until save.
    expect(service.draft()?.daily.openOnStartup).toBe(false);
    expect(service.dailyOpenOnStartup()).toBe(true);
    expect(service.templatesDir()).toBe('templates');

    await service.save();
    expect(service.dailyOpenOnStartup()).toBe(false);
    expect(service.templatesDir()).toBe('snippets');
  });

  it('closeScreen discards the draft', () => {
    service.patchLlm({ apiKey: 'sk-nope' });
    service.closeScreen();

    expect(service.screenOpen()).toBe(false);
    expect(service.isDirty()).toBe(false);
    expect(service.config()?.llm.apiKey).toBeNull();
  });

  it('reopening the screen reseeds the draft from disk', async () => {
    service.patchLlm({ apiKey: 'sk-a' });
    await service.save();
    service.patchLlm({ apiKey: 'sk-b' });
    service.openScreen();

    expect(service.draft()?.llm.apiKey).toBe('sk-a');
    expect(service.isDirty()).toBe(false);
  });

  it('surfaces a save failure and keeps the draft intact', async () => {
    window.dreyApi = {
      ...harness.api,
      setConfig: () => Promise.reject(new Error('disk full')),
    } as DreyApi;

    service.patchLlm({ apiKey: 'sk-keep-me' });
    expect(await service.save()).toBe(false);

    expect(service.saveError()).toBe('disk full');
    expect(service.draft()?.llm.apiKey).toBe('sk-keep-me'); // not thrown away
    expect(service.isDirty()).toBe(true);
  });

  describe('"don’t ask again" from the confirmation dialog', () => {
    let triggerId: string;

    beforeEach(async () => {
      // No default triggers any more -- seed one and save it.
      const templateId = service.addTemplate();
      service.updateTemplate(templateId, { name: 'Reformat', prompt: 'tidy' });
      service.addTrigger(templateId, 'manual');
      await service.save();
      triggerId = service.config()!.actions.triggers[0].id;
    });

    it('persists immediately and updates config and draft together', async () => {
      await service.setTriggerConfirmImmediate(triggerId, false);

      const stored = harness.stored().actions.triggers.find((t) => t.id === triggerId);
      expect(stored?.confirm).toBe(false);
      expect(service.config()?.actions.triggers[0].confirm).toBe(false);
      // The draft got the same edit, so an open Settings screen won't undo it.
      expect(service.draft()?.actions.triggers[0].confirm).toBe(false);
      expect(service.isDirty()).toBe(false);
    });

    it('leaves unrelated unsaved draft edits alone', async () => {
      service.patchLlm({ apiKey: 'sk-draft-only' });

      await service.setTriggerConfirmImmediate(triggerId, false);

      expect(service.draft()?.llm.apiKey).toBe('sk-draft-only');
      expect(harness.stored().llm.apiKey).toBeNull(); // still unsaved
      expect(service.isDirty()).toBe(true);
    });
  });

  describe('editor content zoom (Ctrl +/-/0)', () => {
    it('persists the clamped scale immediately and updates config + draft together', async () => {
      await service.setEditorFontScale(1.3);

      expect(service.editorFontScale()).toBe(1.3);
      expect(harness.stored().editor.fontScale).toBe(1.3);
      expect(service.draft()?.editor.fontScale).toBe(1.3);
      expect(service.isDirty()).toBe(false);
    });

    it('clamps out-of-range requests rather than rejecting them', async () => {
      await service.setEditorFontScale(99);
      expect(service.editorFontScale()).toBe(2.5);
    });

    it('does not write when the value is unchanged', async () => {
      const before = harness.setCalls();
      await service.setEditorFontScale(1); // already the default
      expect(harness.setCalls()).toBe(before);
    });

    it('leaves unrelated unsaved draft edits alone', async () => {
      service.patchLlm({ apiKey: 'sk-draft-only' });

      await service.setEditorFontScale(1.5);

      expect(service.draft()?.llm.apiKey).toBe('sk-draft-only');
      expect(harness.stored().llm.apiKey).toBeNull();
      expect(service.isDirty()).toBe(true);
    });
  });

  describe('editor font family (Settings -> Appearance) — draft model (ADR-0020 later change)', () => {
    it('keeps the choice in the draft and previews it live until save', () => {
      service.setEditorFontFamily('serif');

      expect(service.editorFontFamily()).toBe('serif'); // live preview (screen open)
      expect(service.draft()?.editor.fontFamily).toBe('serif');
      expect(service.config()?.editor.fontFamily).toBe('sans'); // untouched on disk
      expect(service.isDirty()).toBe(true);
      expect(harness.setCalls()).toBe(0);
    });

    it('rolls the preview back on discard', () => {
      service.setEditorFontFamily('serif');
      service.discard();

      expect(service.editorFontFamily()).toBe('sans');
      expect(service.isDirty()).toBe(false);
    });

    it('reaches disk on save', async () => {
      service.setEditorFontFamily('mono');
      expect(await service.save()).toBe(true);

      expect(harness.stored().editor.fontFamily).toBe('mono');
      expect(service.editorFontFamily()).toBe('mono');
      expect(service.isDirty()).toBe(false);
    });

    it('pins an unknown id to the sans default', () => {
      service.setEditorFontFamily('comic-sans');
      expect(service.draft()?.editor.fontFamily).toBe('sans');
      expect(service.isDirty()).toBe(false); // 'sans' equals the persisted value
    });
  });

  describe('appearance (Settings -> Appearance) — draft model (ADR-0020 later change)', () => {
    it('keeps the UI scale in the draft and previews it live until save', () => {
      service.setAppearanceUiScale('large');

      expect(service.appearanceUiScale()).toBe('large'); // live preview
      expect(service.draft()?.appearance.uiScale).toBe('large');
      expect(service.config()?.appearance.uiScale).toBe('default');
      expect(service.isDirty()).toBe(true);
      expect(harness.setCalls()).toBe(0);
    });

    it('normalises the accent in the draft (sentinel, preset id or #hex; junk -> default)', () => {
      service.setAppearanceAccent('#12ab34');
      expect(service.appearanceAccent()).toBe('#12ab34');
      expect(service.config()?.appearance.accent).toBe('theme');

      service.setAppearanceAccent('bogus');
      expect(service.draft()?.appearance.accent).toBe('theme');
    });

    it('keeps the theme id in the draft and previews it live until save', () => {
      service.setAppearanceTheme('dracula');
      expect(service.appearanceTheme()).toBe('dracula');
      expect(service.draft()?.appearance.theme).toBe('dracula');
      expect(service.config()?.appearance.theme).toBe('drey');
      expect(service.isDirty()).toBe(true);
    });

    it('rolls the whole Appearance preview back on discard', () => {
      service.setAppearanceUiScale('small');
      service.setAppearanceAccent('#0055ff');
      service.setAppearanceTheme('nord');
      service.discard();

      expect(service.appearanceUiScale()).toBe('default');
      expect(service.appearanceAccent()).toBe('theme');
      expect(service.appearanceTheme()).toBe('drey');
      expect(service.isDirty()).toBe(false);
    });

    it('persists on save and stops previewing from the draft', async () => {
      service.setAppearanceUiScale('small');
      expect(await service.save()).toBe(true);

      expect(harness.stored().appearance.uiScale).toBe('small');
      expect(service.appearanceUiScale()).toBe('small');
      expect(service.isDirty()).toBe(false);
    });

    it('leaves unrelated unsaved draft edits alone', () => {
      service.patchLlm({ apiKey: 'sk-draft-only' });
      service.setAppearanceUiScale('small');

      expect(service.draft()?.llm.apiKey).toBe('sk-draft-only');
      expect(harness.stored().llm.apiKey).toBeNull();
      expect(service.isDirty()).toBe(true);
    });

    it('shows the saved config, not the draft, once the screen is closed', () => {
      service.setAppearanceAccent('#0055ff');
      service.closeScreen(); // discards + closes

      expect(service.appearanceAccent()).toBe('theme');
    });
  });
});
