import { SettingsCategoryRegistry } from './settings-registry.service';

describe('SettingsCategoryRegistry category order (req-33)', () => {
  it('lists the core categories alphabetically with About last', () => {
    const registry = new SettingsCategoryRegistry();
    expect(registry.categories().map((c) => c.label)).toEqual([
      'Appearance',
      'Assistant tools',
      'Daily notes',
      'Entry format',
      'LLM',
      'MCP',
      'Panels & plugins',
      'Spelling',
      'Vault',
      'About',
    ]);
  });

  it('sorts plugin pages by label after the core categories, before About', () => {
    const registry = new SettingsCategoryRegistry();
    registry.registerPluginPage({
      id: 'zeta',
      label: 'Zeta plugin',
      hint: '',
      mount: () => () => undefined,
    });
    registry.registerPluginPage({
      id: 'alpha',
      label: 'Alpha plugin',
      hint: '',
      mount: () => () => undefined,
    });
    expect(registry.categories().map((c) => c.label)).toEqual([
      'Appearance',
      'Assistant tools',
      'Daily notes',
      'Entry format',
      'LLM',
      'MCP',
      'Panels & plugins',
      'Spelling',
      'Vault',
      'Alpha plugin',
      'Zeta plugin',
      'About',
    ]);
  });
});
