import { resolveActions } from '../../../shared/llm';
import { DEFAULT_APP_CONFIG, normalizeAppConfig } from '../../../shared/app-config';

describe('resolveActions', () => {
  it('has no actions by default (no default triggers)', () => {
    expect(resolveActions(DEFAULT_APP_CONFIG)).toEqual([]);
  });

  it('joins a trigger to its template, carrying prompt and result kind', () => {
    const config = normalizeAppConfig({
      actions: {
        templates: [{ id: 'u1', name: 'Reformat', prompt: 'tidy up', resultKind: 'document' }],
        triggers: [{ id: 't1', templateId: 'u1', event: 'manual', confirm: true, enabled: true }],
      },
    });
    expect(resolveActions(config)).toEqual([
      {
        triggerId: 't1',
        templateId: 'u1',
        name: 'Reformat',
        prompt: 'tidy up',
        resultKind: 'document',
        event: 'manual',
        confirm: true,
        enabled: true,
        builtin: null,
      },
    ]);
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
