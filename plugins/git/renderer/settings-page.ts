import type { DreyPluginApi, PluginSettingsPageContrib } from '../../../shared/plugin-api/renderer';
import type { VaultGitState } from '../shared/status.js';
import { el } from './dom.js';
import type { RepoSession } from './repo-session.js';

/** Settings → Git: the path of the git executable. */
export function createGitSettingsPage(api: DreyPluginApi, session: RepoSession): PluginSettingsPageContrib {
  return {
    id: 'git',
    label: 'Git',
    hint: 'Git executable',
    description: 'Which git program Drey runs for vaults that are Git repositories.',
    mount: (body) => {
      const field = el('div', 'field');
      const label = el('label', undefined, 'Git executable');
      const input = el('input', 'mono-input');
      input.type = 'text';
      input.spellcheck = false;
      input.id = 'git-settings-path';
      label.htmlFor = input.id;
      field.append(
        label,
        input,
        el(
          'p',
          'field-hint',
          'Leave empty to use the git found on PATH. Set the full path to git.exe when it is installed elsewhere.',
        ),
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
