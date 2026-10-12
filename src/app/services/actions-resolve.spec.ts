import { resolveActions } from '../../../shared/llm';
import {
  BUILTIN_TEMPLATE_IDS,
  DEFAULT_APP_CONFIG,
  LOSSLESS_FORMAT_PROMPT,
  normalizeAppConfig,
} from '../../../shared/app-config';

describe('resolveActions', () => {
  it('resolves the one default action: the lossless template on its manual trigger', () => {
    expect(resolveActions(DEFAULT_APP_CONFIG)).toEqual([
      {
        triggerId: 'trigger:lossless-format',
        templateId: BUILTIN_TEMPLATE_IDS['lossless-format'],
        name: 'Structure note (lossless)',
        prompt: LOSSLESS_FORMAT_PROMPT,
        resultKind: 'document',
        event: 'manual',
        confirm: true,
        enabled: true,
        builtin: 'lossless-format',
      },
    ]);
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
