import type { DreyPluginApi, PluginSettingsPageContrib } from '../../../shared/plugin-api/renderer';

/** The reminder switch's config key (absent = on, the drawio fallback pattern). */
export const REMINDERS_ENABLED_KEY = 'remindersEnabled';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/** Settings → Tasks: the due-date reminder switch (req-65). Saves as it is made (rule 3). */
export function createTasksSettingsPage(api: DreyPluginApi): PluginSettingsPageContrib {
  return {
    id: 'tasks',
    label: 'Tasks',
    hint: 'Due-date reminders',
    description: 'Whether Drey notifies you about tasks whose due date has arrived.',
    mount: (body) => {
      const row = el('label', 'switch-row');
      const box = el('input') as HTMLInputElement;
      box.type = 'checkbox';
      box.id = 'tasks-reminders-enabled';
      box.checked = true;
      void api.settings.get<boolean>(REMINDERS_ENABLED_KEY).then((value) => {
        box.checked = value !== false;
      });
      box.addEventListener('change', () => {
        void api.settings.set(REMINDERS_ENABLED_KEY, box.checked);
      });
      const text = el('span');
      text.append(
        el('span', 'switch-label', 'Due-date reminders'),
        el(
          'span',
          'switch-hint',
          'Once a day, a system notification counts the open tasks that are due today or overdue — across every vault. A click opens the Tasks panel. Nothing is scheduled while Drey is closed; the next start reports what piled up, once.',
        ),
      );
      row.append(box, text);
      body.appendChild(row);
      return () => undefined;
    },
  };
}
