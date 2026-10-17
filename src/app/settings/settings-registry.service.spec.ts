import { SettingsCategoryRegistry } from './settings-registry.service';

/** Stands in for `PluginSettingsHost`, which the registrar hands in. */
class FakePageHost {}

describe('SettingsCategoryRegistry category order (req-33)', () => {
  it('lists the core categories alphabetically with About last', () => {
    const registry = new SettingsCategoryRegistry();
    expect(registry.categories().map((c) => c.label)).toEqual([
      'Appearance',
      'Assistant tools',
      'Daily notes',
      'Entry format',
      'Keyboard shortcuts',
      'LLM',
      'MCP',
      'Panels & plugins',
      'Spelling',
      'Updates',
      'Vault',
      'About',
    ]);
  });

  it('sorts plugin pages by label after the core categories, before About', () => {
    const registry = new SettingsCategoryRegistry();
    const mount = () => () => undefined;
    registry.registerPluginPage({ id: 'zeta', label: 'Zeta plugin', hint: '', mount }, FakePageHost);
    registry.registerPluginPage(
      { id: 'alpha', label: 'Alpha plugin', hint: '', mount },
      FakePageHost,
    );
    expect(registry.categories().map((c) => c.label)).toEqual([
      'Appearance',
      'Assistant tools',
      'Daily notes',
      'Entry format',
      'Keyboard shortcuts',
      'LLM',
      'MCP',
      'Panels & plugins',
      'Spelling',
      'Updates',
      'Vault',
      'Alpha plugin',
      'Zeta plugin',
      'About',
    ]);
  });
});
