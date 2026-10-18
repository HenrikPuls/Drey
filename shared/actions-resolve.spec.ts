import { resolveActions } from './llm';
import {
  BUILTIN_TEMPLATE_IDS,
  DEFAULT_ACTIONS_CONFIG,
  LOSSLESS_FORMAT_PROMPT,
  normalizeActionsConfig,
} from './app-config';

describe('resolveActions', () => {
  it('resolves the one default action: the lossless template on its manual trigger', () => {
    expect(resolveActions(DEFAULT_ACTIONS_CONFIG)).toEqual([
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
    const actions = normalizeActionsConfig({
      templates: [{ id: 'u1', name: 'Reformat', prompt: 'tidy up', resultKind: 'document' }],
      triggers: [{ id: 't1', templateId: 'u1', event: 'manual', confirm: true, enabled: true }],
    });
    expect(resolveActions(actions)).toEqual([
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
    const actions = normalizeActionsConfig({
      templates: DEFAULT_ACTIONS_CONFIG.templates,
      triggers: [
        { id: 't-x', templateId: 'nope', event: 'manual', confirm: true, enabled: true },
      ],
    });
    expect(resolveActions(actions)).toEqual([]);
  });
});
