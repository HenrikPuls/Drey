/**
 * The Assistant plugin's Settings page (ADR-0044 stage 7), ported from
 * `src/app/settings/actions/` to plain DOM. It edits the plugin's OWN
 * config (the `actions` key, ADR-0010 later change) and saves immediately
 * — each patch is a read-modify-write of the stored section.
 *
 * The Actions page is the engine's config UI: triggers (which template on
 * which event) and the prompt template library. `normalizeActionsConfig`
 * re-injects the built-in templates, so "delete" is hidden for those.
 */
import type { DreyPluginApi, PluginSettingsPageContrib } from '../../../shared/plugin-api/renderer';
import { normalizeActionsConfig, type ActionsConfig } from '../../../shared/app-config';
import type {
  ActionEvent,
  ActionTemplate,
  ActionTrigger,
} from '../../../shared/app-config';

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

/**
 * The actions data is the plugin's OWN config (the `actions` key, ADR-0010
 * later change): read through `api.settings`, normalized, mutated, written
 * back whole — the plugin config store has no patch, and the section is
 * small enough that read-modify-write-whole is the honest round.
 */
async function loadActions(api: DreyPluginApi): Promise<ActionsConfig> {
  return normalizeActionsConfig(await api.settings.get('actions'));
}

// -- Actions page ------------------------------------------------------------

const EVENTS: ReadonlyArray<{ id: ActionEvent; label: string }> = [
  { id: 'manual', label: 'Manual button' },
  { id: 'on-save', label: 'On save' },
];

const RESULT_KINDS: ReadonlyArray<{ id: 'localized' | 'document'; label: string }> = [
  { id: 'localized', label: 'Localized — inline diff' },
  { id: 'document', label: 'Whole document — side-by-side' },
];

/** Plugin-config key (the plugin's own store): the button at a selection, default on. */
export const SELECTION_BUTTON_SETTING = 'selectionButton.enabled';

export function actionsSettingsPage(
  api: DreyPluginApi,
  onPatched: () => void,
  onSelectionButton: (on: boolean) => void,
): PluginSettingsPageContrib {
  return {
    id: 'actions',
    label: 'Actions',
    hint: 'Prompt templates & triggers',
    description: 'The prompts the assistant can run on a note, and when each one runs.',
    mount(root) {
      const patchActions = (
        change: (section: ActionsConfig) => void,
      ): Promise<void> =>
        (async () => {
          const section = structuredClone(await loadActions(api));
          change(section);
          await api.settings.set('actions', section);
        })().then(onPatched);
      root.classList.add('assistant-actions-settings');

      const triggersSection = el('section');
      triggersSection.appendChild(el('h3', undefined, 'Triggers'));
      triggersSection.appendChild(
        el(
          'p',
          'section-hint',
          'When each template runs. “On save” runs from the note-save pipeline; “Manual button” runs from the editor’s ⋯ menu. Each mapping confirms before applying unless you turn that off here or via “don’t ask again”.',
        ),
      );
      const triggerList = el('ul', 'rows');
      triggersSection.appendChild(triggerList);
      const addTriggerRow = el('div', 'row compact add-trigger');
      triggersSection.appendChild(addTriggerRow);
      root.appendChild(triggersSection);

      const templatesSection = el('section');
      templatesSection.appendChild(el('h3', undefined, 'Template library'));
      templatesSection.appendChild(
        el(
          'p',
          'section-hint',
          'A template is a name, a prompt, and the kind of change it makes. “Autotagging” suggests tags for a note section (the editor’s “Suggest tags” row); “Update summary” rebuilds a master document’s Summary section. The note itself is sent alongside the prompt; {{AVAILABLE_TAGS}} in a prompt is replaced with the vault’s tag vocabulary when it runs.',
        ),
      );
      const templateList = el('ul', 'cards');
      templatesSection.appendChild(templateList);
      const addTemplateBtn = el('button', 'ghost', 'Add action') as HTMLButtonElement;
      addTemplateBtn.type = 'button';
      addTemplateBtn.addEventListener('click', () => {
        void (async () => {
          const id = `template:${uid()}`;
          await patchActions((section) => {
            section.templates.push({ id, name: 'New action', prompt: '', resultKind: 'document', builtin: null });
          });
          await reload();
        })();
      });
      templatesSection.appendChild(addTemplateBtn);
      root.appendChild(templatesSection);

      // The button at a selection (milestone 74) lives in the plugin's own
      // config, not in the app config.
      const selectionSection = el('section');
      selectionSection.appendChild(el('h3', undefined, 'Selection'));
      const selectionRow = el('label', 'switch-row');
      const selectionBox = el('input') as HTMLInputElement;
      selectionBox.type = 'checkbox';
      selectionBox.checked = true;
      void api.settings.get<boolean>(SELECTION_BUTTON_SETTING).then((value) => {
        selectionBox.checked = value !== false;
      });
      selectionBox.addEventListener('change', () => {
        const on = selectionBox.checked;
        void api.settings.set(SELECTION_BUTTON_SETTING, on).then(() => onSelectionButton(on));
      });
      const selectionText = el('span');
      selectionText.append(
        el('span', 'switch-label', 'Show the assistant button at a selection'),
        el(
          'span',
          'switch-hint',
          'Selecting text in a note shows a small button that asks the assistant about it — with your own question, a prompt from the prompts folder, or a manual Action.',
        ),
      );
      selectionRow.append(selectionBox, selectionText);
      selectionSection.appendChild(selectionRow);
      root.appendChild(selectionSection);

      let openTemplateId: string | null = null;
      let config: ActionsConfig | null = null;

      const templateName = (id: string): string =>
        config?.templates.find((t) => t.id === id)?.name ?? '(deleted template)';

      const triggerRow = (trigger: ActionTrigger): HTMLLIElement => {
        const row = el('li', 'row');
        row.appendChild(el('span', 'name', templateName(trigger.templateId)));

        const eventSelect = el('select') as HTMLSelectElement;
        for (const event of EVENTS) {
          const option = el('option', undefined, event.label) as HTMLOptionElement;
          option.value = event.id;
          eventSelect.appendChild(option);
        }
        eventSelect.value = trigger.event;
        eventSelect.setAttribute('aria-label', 'Trigger event');
        eventSelect.addEventListener('change', () => {
          void patchActions((section) => {
            const t = section.triggers.find((entry) => entry.id === trigger.id);
            if (t) {
              t.event = eventSelect.value as ActionEvent;
            }
          });
        });
        row.appendChild(eventSelect);

        for (const [key, label] of [
          ['confirm', 'Confirm'],
          ['enabled', 'Enabled'],
        ] as const) {
          const check = el('label', 'check');
          const box = el('input') as HTMLInputElement;
          box.type = 'checkbox';
          box.checked = trigger[key];
          box.addEventListener('change', () => {
            const value = box.checked;
            void patchActions((section) => {
              const t = section.triggers.find((entry) => entry.id === trigger.id);
              if (t) {
                t[key] = value;
              }
            });
          });
          check.append(box, el('span', undefined, label));
          row.appendChild(check);
        }

        const remove = el('button', 'link-danger', 'Remove') as HTMLButtonElement;
        remove.type = 'button';
        remove.addEventListener('click', () => {
          void patchActions((section) => {
            section.triggers = section.triggers.filter((t) => t.id !== trigger.id);
          }).then(reload);
        });
        row.appendChild(remove);
        return row;
      };

      const templateRow = (template: ActionTemplate): HTMLLIElement => {
        const item = el('li', 'card template');
        const headRow = el('div', 'row compact template-head');

        const nameInput = el('input') as HTMLInputElement;
        nameInput.type = 'text';
        nameInput.value = template.name;
        nameInput.setAttribute('aria-label', 'Action name');
        nameInput.addEventListener('input', () => {
          const value = nameInput.value;
          void patchActions((section) => {
            const t = section.templates.find((entry) => entry.id === template.id);
            if (t) {
              t.name = value;
            }
          });
        });
        headRow.appendChild(nameInput);

        if (template.builtin !== null) {
          headRow.appendChild(el('span', 'badge', 'built-in'));
        }

        const kindSelect = el('select') as HTMLSelectElement;
        for (const kind of RESULT_KINDS) {
          const option = el('option', undefined, kind.label) as HTMLOptionElement;
          option.value = kind.id;
          kindSelect.appendChild(option);
        }
        kindSelect.value = template.resultKind;
        kindSelect.setAttribute('aria-label', 'Result kind');
        kindSelect.addEventListener('change', () => {
          void patchActions((section) => {
            const t = section.templates.find((entry) => entry.id === template.id);
            if (t) {
              t.resultKind = kindSelect.value as ActionTemplate['resultKind'];
            }
          });
        });
        headRow.appendChild(kindSelect);

        const toggleBtn = el('button', 'link') as HTMLButtonElement;
        toggleBtn.type = 'button';
        toggleBtn.addEventListener('click', () => {
          openTemplateId = openTemplateId === template.id ? null : template.id;
          void reload();
        });
        headRow.appendChild(toggleBtn);

        if (template.builtin === null) {
          const deleteBtn = el('button', 'link-danger', 'Delete') as HTMLButtonElement;
          deleteBtn.type = 'button';
          deleteBtn.addEventListener('click', () => {
            // User templates only -- normalizeAppConfig re-injects a built-in.
            void patchActions((section) => {
              section.templates = section.templates.filter((t) => t.id !== template.id);
              section.triggers = section.triggers.filter((t) => t.templateId !== template.id);
            }).then(reload);
          });
          headRow.appendChild(deleteBtn);
        }
        item.appendChild(headRow);

        if (openTemplateId === template.id) {
          const prompt = el('textarea') as HTMLTextAreaElement;
          prompt.rows = 6;
          prompt.className = 'mono-input';
          prompt.setAttribute('aria-label', 'Prompt');
          prompt.spellcheck = false;
          prompt.value = template.prompt;
          prompt.addEventListener('input', () => {
            const value = prompt.value;
            void patchActions((section) => {
              const t = section.templates.find((entry) => entry.id === template.id);
              if (t) {
                t.prompt = value;
              }
            });
          });
          item.appendChild(prompt);
        }
        toggleBtn.textContent = openTemplateId === template.id ? 'Hide prompt' : 'Edit prompt';
        return item;
      };

      const reload = async (): Promise<void> => {
        config = await loadActions(api);

        triggerList.textContent = '';
        if (config.triggers.length === 0) {
          triggerList.appendChild(el('li', 'empty', 'No triggers. Add one below.'));
        }
        for (const trigger of config.triggers) {
          triggerList.appendChild(triggerRow(trigger));
        }
        addTriggerRow.textContent = '';

        const templateSelect = el('select') as HTMLSelectElement;
        templateSelect.setAttribute('aria-label', 'Template for the new trigger');
        for (const template of config.templates) {
          const option = el('option', undefined, template.name) as HTMLOptionElement;
          option.value = template.id;
          templateSelect.appendChild(option);
        }
        const eventSelect = el('select') as HTMLSelectElement;
        for (const event of EVENTS) {
          const option = el('option', undefined, event.label) as HTMLOptionElement;
          option.value = event.id;
          eventSelect.appendChild(option);
        }
        eventSelect.setAttribute('aria-label', 'Event for the new trigger');
        const addBtn = el('button', 'ghost small', 'Add trigger') as HTMLButtonElement;
        addBtn.type = 'button';
        addBtn.addEventListener('click', () => {
          const templateId = templateSelect.value || config?.templates[0]?.id;
          if (templateId !== undefined) {
            void patchActions((section) => {
              section.triggers.push({
                id: `trigger:${uid()}`,
                templateId,
                event: eventSelect.value as ActionEvent,
                confirm: true,
                enabled: true,
              });
            }).then(reload);
          }
        });
        addTriggerRow.append(templateSelect, eventSelect, addBtn);

        templateList.textContent = '';
        for (const template of config.templates) {
          templateList.appendChild(templateRow(template));
        }
      };

      void reload();
      return () => {};
    },
  };
}

/** `crypto.randomUUID` in the app; a cheap fallback for test contexts. */
function uid(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
