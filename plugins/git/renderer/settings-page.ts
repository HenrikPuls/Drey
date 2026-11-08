import type { DreyPluginApi, PluginSettingsPageContrib } from '../../../shared/plugin-api/renderer';
import type { VaultGitState } from '../shared/status.js';
import { el } from './dom.js';
import type { RepoSession } from './repo-session.js';

/** Settings → Git: the path of the git executable. */
export function createGitSettingsPage(api: DreyPluginApi, session: RepoSession): PluginSettingsPageContrib {
  return {
    id: 'git',
    label: api.i18n.t('git.settings.label'),
    hint: api.i18n.t('git.settings.hint'),
    description: api.i18n.t('git.settings.description'),
    mount: (body) => {
      const field = el('div', 'field');
      const label = el('label', undefined, api.i18n.t('git.settings.executable'));
      const input = el('input', 'mono-input');
      input.type = 'text';
      input.spellcheck = false;
      input.id = 'git-settings-path';
      label.htmlFor = input.id;
      field.append(
        label,
        input,
        el('p', 'field-hint', api.i18n.t('git.settings.executable_hint')),
      );
      body.appendChild(field);

      void api.settings.get<string>('gitPath').then((value) => {
        input.value = value ?? '';
      });
      const save = async (): Promise<void> => {
        await api.settings.set('gitPath', input.value.trim());
        session.applyStates((await api.backend.invoke('configChanged')) as VaultGitState[]);
      };
      input.addEventListener('change', () => void save().catch(() => undefined));
      return () => undefined;
    },
  };
}
