import {
  BUILTIN_TEMPLATE_IDS,
  DEFAULT_APP_CONFIG,
  DEFAULT_TEMPLATES_CONFIG,
  EDITOR_FONT_SCALE_MAX,
  EDITOR_FONT_SCALE_MIN,
  normalizeAppConfig,
} from '../../../shared/app-config';

describe('normalizeAppConfig', () => {
  it('fills a completely empty input from defaults', () => {
    const config = normalizeAppConfig({});
    expect(config.version).toBe(1);
    expect(config.llm.enabled).toBe(false);
    expect(config.llm.baseUrl).toBe(DEFAULT_APP_CONFIG.llm.baseUrl);
    expect(config.llm.model).toBeNull();
    expect(config.actions.templates.map((t) => t.builtin)).toEqual(['search-summary', 'autotag']);
    expect(config.actions.triggers).toHaveLength(0);
  });

  it('round-trips the defaults unchanged', () => {
    expect(normalizeAppConfig(DEFAULT_APP_CONFIG)).toEqual(DEFAULT_APP_CONFIG);
  });

  it('defaults the MCP block to off and coerces a bad port', () => {
    expect(normalizeAppConfig({}).mcp).toEqual({
      enabled: false,
      httpEnabled: false,
      httpPort: 4319,
      yolo: false,
    });
    expect(normalizeAppConfig({ mcp: { httpPort: 80 } }).mcp.httpPort).toBe(1024);
    expect(normalizeAppConfig({ mcp: { httpPort: 999999 } }).mcp.httpPort).toBe(65535);
    expect(normalizeAppConfig({ mcp: { enabled: 'yes', yolo: 1 } }).mcp.enabled).toBe(false);
  });

  it('coerces malformed llm fields and a blank base URL', () => {
    const config = normalizeAppConfig({
      llm: { enabled: 'yes', baseUrl: '   ', model: 42, apiKey: 7 },
    });
    expect(config.llm.enabled).toBe(false);
    expect(config.llm.baseUrl).toBe(DEFAULT_APP_CONFIG.llm.baseUrl);
    expect(config.llm.model).toBeNull();
    expect(config.llm.apiKey).toBeNull();
    // A pre-provider config file has no `provider` key at all.
    expect(config.llm.provider).toBe('lmstudio');
  });

  it('falls back to the default provider for an unknown id, keeps a known one', () => {
    expect(normalizeAppConfig({ llm: { provider: 'zai-glm' } }).llm.provider).toBe('zai-glm');
    expect(normalizeAppConfig({ llm: { provider: 'skynet' } }).llm.provider).toBe('lmstudio');
    expect(normalizeAppConfig({}).llm.provider).toBe('lmstudio');
  });

  it('defaults the API key to null and keeps a set one, trimmed', () => {
    expect(normalizeAppConfig({}).llm.apiKey).toBeNull();
    expect(normalizeAppConfig({ llm: { apiKey: '  sk-unsloth-abc123  ' } }).llm.apiKey).toBe(
      'sk-unsloth-abc123',
    );
  });

  it('treats a blank API key or model as unset', () => {
    const config = normalizeAppConfig({ llm: { apiKey: '   ', model: '  ' } });
    expect(config.llm.apiKey).toBeNull();
    expect(config.llm.model).toBeNull();
  });

  it('keeps a custom base URL and model together with a key (Unsloth-style setup)', () => {
    const config = normalizeAppConfig({
      llm: {
        enabled: true,
        baseUrl: 'http://127.0.0.1:8888/v1',
        apiKey: 'sk-unsloth-KEY',
        model: 'Bonsai-27B-GGUF',
      },
    });
    expect(config.llm).toEqual({
      enabled: true,
      provider: 'lmstudio',
      baseUrl: 'http://127.0.0.1:8888/v1',
      apiKey: 'sk-unsloth-KEY',
      model: 'Bonsai-27B-GGUF',
    });
  });

  it('keeps a user edit to the built-in template, matched by id', () => {
    const config = normalizeAppConfig({
      actions: {
        templates: [
          {
            id: BUILTIN_TEMPLATE_IDS['search-summary'],
            name: 'My digest',
            prompt: 'do it',
            resultKind: 'document',
          },
        ],
        triggers: [],
      },
    });
    const builtin = config.actions.templates.find((t) => t.builtin === 'search-summary');
    expect(builtin).toMatchObject({ name: 'My digest', prompt: 'do it', resultKind: 'document' });
    expect(config.actions.templates.filter((t) => t.builtin === 'search-summary')).toHaveLength(1);
  });

  it('re-injects the built-ins the user deleted', () => {
    const config = normalizeAppConfig({ actions: { templates: [], triggers: [] } });
    expect(config.actions.templates.map((t) => t.builtin)).toEqual(['search-summary', 'autotag']);
  });

  it('drops the retired note-summary built-in from a stored config, without resurrecting it', () => {
    const config = normalizeAppConfig({
      actions: {
        templates: [
          // A config written before the retirement: the built-in (possibly
          // with user edits) sits in the stored list.
          { id: 'builtin:note-summary', name: 'Summarise note', prompt: 'sum', resultKind: 'document' },
          { id: 'u1', name: 'Mine', prompt: 'go', resultKind: 'localized' },
        ],
        triggers: [
          {
            id: 't1',
            templateId: 'builtin:note-summary',
            event: 'on-save',
            confirm: false,
            enabled: true,
          },
        ],
      },
    });
    expect(config.actions.templates.map((t) => t.builtin)).toEqual(['search-summary', 'autotag', null]);
    expect(config.actions.templates.filter((t) => t.id === 'builtin:note-summary')).toHaveLength(0);
    expect(config.actions.triggers).toHaveLength(0);
  });

  it('drops a half-written user template but keeps a valid one', () => {
    const config = normalizeAppConfig({
      actions: {
        templates: [
          { id: 'u1', name: '', prompt: 'x' },
          { id: 'u2', name: 'Reformat', prompt: 'tidy up', resultKind: 'document' },
        ],
        triggers: [],
      },
    });
    const user = config.actions.templates.filter((t) => t.builtin === null);
    expect(user).toHaveLength(1);
    expect(user[0]).toMatchObject({ id: 'u2', name: 'Reformat', builtin: null });
  });

  it('normalises the entry-template section: built-ins re-injected, activeId falls back', () => {
    const fresh = normalizeAppConfig({});
    expect(fresh.entry.templates.map((t) => t.builtin)).toEqual(['classic', 'ruled']);
    expect(fresh.entry.activeId).toBe('builtin:entry-classic');

    const edited = normalizeAppConfig({
      entry: {
        activeId: 'builtin:entry-ruled',
        templates: [
          { id: 'builtin:entry-classic', name: 'Klassisch', pattern: '## {{time}}' },
          { id: 'u1', name: '', pattern: 'x' }, // half-written -> dropped
          { id: 'u2', name: 'Mine', pattern: '{{content}}' },
        ],
      },
    });
    const classic = edited.entry.templates.find((t) => t.builtin === 'classic');
    expect(classic).toMatchObject({ name: 'Klassisch', pattern: '## {{time}}' });
    expect(edited.entry.templates.map((t) => t.builtin)).toEqual(['classic', 'ruled', null]);
    expect(edited.entry.templates.filter((t) => t.builtin === null)[0]).toMatchObject({ id: 'u2' });
    expect(edited.entry.activeId).toBe('builtin:entry-ruled');

    // An activeId that names no template falls back to the classic id.
    expect(normalizeAppConfig({ entry: { activeId: 'gone', templates: [] } }).entry.activeId).toBe(
      'builtin:entry-classic',
    );
  });

  it('defaults the daily block to open-on-startup and coerces a junk value', () => {
    expect(normalizeAppConfig({}).daily).toEqual({ openOnStartup: true, dir: 'daily' });
    expect(normalizeAppConfig({ daily: { openOnStartup: 'yes' } }).daily.openOnStartup).toBe(true);
    expect(normalizeAppConfig({ daily: { openOnStartup: false } }).daily.openOnStartup).toBe(false);
  });

  it('normalises the daily folder: default, slash-trim, back-slash fold, .. rejection', () => {
    expect(normalizeAppConfig({}).daily.dir).toBe('daily');
    expect(normalizeAppConfig({ daily: { dir: '  /Journal/  ' } }).daily.dir).toBe('Journal');
    expect(normalizeAppConfig({ daily: { dir: 'meta\\journal' } }).daily.dir).toBe('meta/journal');
    expect(normalizeAppConfig({ daily: { dir: '../escape' } }).daily.dir).toBe('daily');
    expect(normalizeAppConfig({ daily: { dir: 'a/./b' } }).daily.dir).toBe('daily');
    expect(normalizeAppConfig({ daily: { dir: '' } }).daily.dir).toBe('daily');
    expect(normalizeAppConfig({ daily: { dir: 42 } }).daily.dir).toBe('daily');
    // The two daily fields normalise independently.
    expect(normalizeAppConfig({ daily: { dir: 'Journal' } }).daily).toEqual({
      openOnStartup: true,
      dir: 'Journal',
    });
  });

  it('defaults the vault block to not watching and coerces a junk value', () => {
    expect(normalizeAppConfig({}).vault).toEqual({
      watch: false,
      updateLinksOnRename: 'ask',
      history: { enabled: true, keepDays: 30, maxPerFile: 50 },
    });
    expect(
      normalizeAppConfig({ vault: { history: { enabled: false, keepDays: 9999, maxPerFile: 'x' } } }).vault.history,
    ).toEqual({ enabled: false, keepDays: 365, maxPerFile: 50 });
    expect(normalizeAppConfig({ vault: { updateLinksOnRename: 'x' } }).vault.updateLinksOnRename).toBe('ask');
    expect(normalizeAppConfig({ vault: { updateLinksOnRename: 'never' } }).vault.updateLinksOnRename).toBe('never');
    expect(normalizeAppConfig({ vault: { watch: 'yes' } }).vault.watch).toBe(false);
    expect(normalizeAppConfig({ vault: { watch: true } }).vault.watch).toBe(true);
  });

  it('tools (ADR-0063): defaults, and a config from before the slice inherits the MCP switch', () => {
    expect(normalizeAppConfig({ tools: {} }).tools).toEqual({
      vault: { enabled: false, write: 'confirm' },
      tasks: { enabled: true },
      templates: { enabled: true, write: 'auto' },
      webFetch: { enabled: false, approval: 'ask' },
      servers: [],
    });
    // No `tools` key at all: what mcp.enabled / mcp.yolo meant for the assistant carries over.
    expect(normalizeAppConfig({ mcp: { enabled: true, yolo: true } }).tools.vault).toEqual({
      enabled: true,
      write: 'auto',
    });
    expect(normalizeAppConfig({ mcp: { enabled: true } }).tools.vault).toEqual({
      enabled: true,
      write: 'confirm',
    });
    // Once the slice exists, the MCP switch no longer steers it.
    expect(normalizeAppConfig({ mcp: { enabled: true }, tools: {} }).tools.vault.enabled).toBe(false);
  });

  it('tools.servers: slug ids made unique, transport by kind, junk dropped', () => {
    const { servers } = normalizeAppConfig({
      tools: {
        servers: [
          { name: 'Brave Search!', transport: { kind: 'http', url: ' https://x/mcp ', headers: { A: 'b', n: 3 } } },
          { id: 'Brave Search', name: '', approval: 'allow', enabled: false, transport: { command: 'npx', args: ['-y', 4, 'pkg'], env: { KEY: 'v' } } },
          'junk',
        ],
      },
    }).tools;
    expect(servers).toEqual([
      {
        id: 'brave-search',
        name: 'Brave Search!',
        enabled: true,
        approval: 'ask',
        transport: { kind: 'http', url: 'https://x/mcp', headers: { A: 'b' } },
      },
      {
        id: 'brave-search-2',
        name: 'brave-search-2',
        enabled: false,
        approval: 'allow',
        transport: { kind: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { KEY: 'v' } },
      },
    ]);
  });

  it('normalises the widgets block: empty default, string list, dedupe, junk drop', () => {
    expect(normalizeAppConfig({}).widgets).toEqual({ disabled: [] });
    expect(normalizeAppConfig({ widgets: { disabled: 'nope' } }).widgets.disabled).toEqual([]);
    expect(
      normalizeAppConfig({ widgets: { disabled: ['tasks', 'tasks', '', 3, 'calendar'] } }).widgets
        .disabled,
    ).toEqual(['tasks', 'calendar']);
  });

  it('normalises the templates folder: default, slash-trim, nested path, .. rejection', () => {
    // A missing config seeds the snippet library (milestone 46); the dir
    // rules are unaffected.
    expect(normalizeAppConfig({}).templates).toEqual(DEFAULT_TEMPLATES_CONFIG);
    expect(normalizeAppConfig({ templates: { snippets: [] } }).templates.dir).toBe('templates');
    expect(normalizeAppConfig({ templates: { dir: '  /snippets/  ' } }).templates.dir).toBe(
      'snippets',
    );
    expect(normalizeAppConfig({ templates: { dir: 'meta\\templates' } }).templates.dir).toBe(
      'meta/templates',
    );
    expect(normalizeAppConfig({ templates: { dir: '../escape' } }).templates.dir).toBe('templates');
    expect(normalizeAppConfig({ templates: { dir: 'a/./b' } }).templates.dir).toBe('templates');
    expect(normalizeAppConfig({ templates: { dir: '' } }).templates.dir).toBe('templates');
    expect(normalizeAppConfig({ templates: { dir: 42 } }).templates.dir).toBe('templates');
  });

  it('fills the spellcheck section from defaults', () => {
    const config = normalizeAppConfig({});
    expect(config.spellcheck).toEqual({
      enabled: true,
      language: 'de',
      autoDetect: true,
      dictionaries: [],
      personalWords: [],
      languageWords: {},
    });
  });

  it('normalises spellcheck word lists: trims, dedupes, drops empty language keys', () => {
    const config = normalizeAppConfig({
      spellcheck: {
        personalWords: ['  Lariscus ', 'Lariscus', '', 7, 'Drey'],
        languageWords: { de: ['Montag', ' Montag', 'x'], en: [], fr: 'nope', junk: [1, 2] },
      },
    });
    expect(config.spellcheck.personalWords).toEqual(['Lariscus', 'Drey']);
    expect(config.spellcheck.languageWords).toEqual({ de: ['Montag', 'x'] });
    expect(
      normalizeAppConfig({ spellcheck: { languageWords: [] } }).spellcheck.languageWords,
    ).toEqual({});
  });

  it('defaults the editor font scale to 1 and clamps an out-of-range or junk value', () => {
    expect(normalizeAppConfig({}).editor).toEqual({ fontScale: 1, fontFamily: 'sans' });
    expect(normalizeAppConfig({ editor: { fontScale: 99 } }).editor.fontScale).toBe(
      EDITOR_FONT_SCALE_MAX,
    );
    expect(normalizeAppConfig({ editor: { fontScale: 0.1 } }).editor.fontScale).toBe(
      EDITOR_FONT_SCALE_MIN,
    );
    expect(normalizeAppConfig({ editor: { fontScale: 'big' } }).editor.fontScale).toBe(1);
  });

  it('snaps the editor font scale to a 0.05 grid so repeated steps do not drift', () => {
    expect(normalizeAppConfig({ editor: { fontScale: 1.2000000000000002 } }).editor.fontScale).toBe(
      1.2,
    );
  });

  it('defaults the editor font family to sans and rejects an unknown id', () => {
    expect(normalizeAppConfig({}).editor.fontFamily).toBe('sans');
    expect(normalizeAppConfig({ editor: { fontFamily: 'serif' } }).editor.fontFamily).toBe('serif');
    expect(normalizeAppConfig({ editor: { fontFamily: 'comic-sans' } }).editor.fontFamily).toBe(
      'sans',
    );
    expect(normalizeAppConfig({ editor: { fontFamily: 42 } }).editor.fontFamily).toBe('sans');
  });

  it('defaults appearance and keeps a valid scale step / accent / theme', () => {
    expect(normalizeAppConfig({}).appearance).toEqual({
      uiScale: 'default',
      accent: 'theme',
      theme: 'anthrazit',
    });
    expect(normalizeAppConfig({ appearance: { uiScale: 'large' } }).appearance.uiScale).toBe(
      'large',
    );
    expect(normalizeAppConfig({ appearance: { uiScale: 'huge' } }).appearance.uiScale).toBe(
      'default',
    );
    expect(normalizeAppConfig({ appearance: { accent: 'sage' } }).appearance.accent).toBe('sage');
    expect(normalizeAppConfig({ appearance: { accent: 'theme' } }).appearance.accent).toBe('theme');
    expect(normalizeAppConfig({ appearance: { accent: '#AABBCC' } }).appearance.accent).toBe(
      '#aabbcc',
    );
    expect(normalizeAppConfig({ appearance: { accent: 'not-a-colour' } }).appearance.accent).toBe(
      'theme',
    );
    expect(normalizeAppConfig({ appearance: { accent: '#xyz' } }).appearance.accent).toBe('theme');
    expect(normalizeAppConfig({ appearance: { theme: 'dracula' } }).appearance.theme).toBe('dracula');
    expect(normalizeAppConfig({ appearance: { theme: '  ' } }).appearance.theme).toBe('anthrazit');
  });

  it('keeps a well-formed custom dictionary and the language pointing at it', () => {
    const config = normalizeAppConfig({
      spellcheck: {
        language: 'fr',
        dictionaries: [
          { id: 'fr', label: 'Français', affPath: 'C:/d/fr.aff', dicPath: 'C:/d/fr.dic' },
        ],
      },
    });
    expect(config.spellcheck.language).toBe('fr');
    expect(config.spellcheck.dictionaries).toHaveLength(1);
  });

  it('drops an incomplete dictionary and falls back to the default language', () => {
    const config = normalizeAppConfig({
      spellcheck: { language: 'fr', dictionaries: [{ id: 'fr', affPath: 'C:/d/fr.aff' }] },
    });
    expect(config.spellcheck.dictionaries).toEqual([]);
    expect(config.spellcheck.language).toBe('de');
  });

  it('refuses a custom dictionary that shadows a bundled language id', () => {
    const config = normalizeAppConfig({
      spellcheck: {
        dictionaries: [{ id: 'de', label: 'Mine', affPath: 'a.aff', dicPath: 'a.dic' }],
      },
    });
    expect(config.spellcheck.dictionaries).toEqual([]);
  });

  it('drops a trigger whose template no longer exists', () => {
    const config = normalizeAppConfig({
      actions: {
        templates: [],
        triggers: [
          { id: 't1', templateId: 'gone', event: 'manual', confirm: true, enabled: true },
          {
            id: 't2',
            templateId: BUILTIN_TEMPLATE_IDS.autotag,
            event: 'on-save',
            confirm: false,
            enabled: true,
          },
        ],
      },
    });
    expect(config.actions.triggers).toHaveLength(1);
    expect(config.actions.triggers[0]).toMatchObject({
      id: 't2',
      event: 'on-save',
      confirm: false,
    });
  });

  it('respects an explicit empty triggers array (user removed them all)', () => {
    const config = normalizeAppConfig({ actions: { templates: [], triggers: [] } });
    expect(config.actions.triggers).toEqual([]);
  });
});
