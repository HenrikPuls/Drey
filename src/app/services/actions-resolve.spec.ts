import { resolveActions } from '../../../shared/llm';
import { DEFAULT_APP_CONFIG, normalizeAppConfig } from '../../../shared/app-config';

describe('resolveActions', () => {
  it('joins the default triggers to their built-in templates', () => {
    const resolved = resolveActions(DEFAULT_APP_CONFIG);
    expect(resolved.map((a) => [a.name, a.event, a.builtin])).toEqual([
      ['Autotagging', 'manual', 'autotagging'],
      ['Update summary', 'manual', 'summary'],
    ]);
    expect(resolved.every((a) => a.confirm && a.enabled)).toBe(true);
  });

  it('carries the template prompt and result kind onto the resolved action', () => {
    const [autotag] = resolveActions(DEFAULT_APP_CONFIG);
    expect(autotag.resultKind).toBe('localized');
    expect(autotag.prompt).toContain('{registry_list}');
  });

  it('drops a trigger whose template id does not resolve', () => {
    const config = normalizeAppConfig({
      actions: {
        templates: DEFAULT_APP_CONFIG.actions.templates,
        triggers: [
          { id: 't-x', templateId: 'nope', event: 'manual', confirm: true, enabled: true },
        ],
      },
    });
    expect(resolveActions(config)).toEqual([]);
  });
});
