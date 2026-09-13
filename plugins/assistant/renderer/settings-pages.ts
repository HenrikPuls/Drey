/**
 * The Assistant plugin's Settings page (ADR-0044 stage 7), ported from
 * `src/app/settings/actions/` to plain DOM. Per ADR-0044 rule 3 it saves
 * immediately through `api.appConfig.patch` — no draft/Save/Discard (that
 * flow is the base categories'); each patch is a read-modify-write of the
 * live config.
 *
 * The Actions page is the engine's config UI: triggers (which template on
 * which event) and the prompt template library. `normalizeAppConfig`
 * re-injects the built-in templates, so "delete" is hidden for those.
 */
import type { DreyPluginApi, PluginSettingsPageContrib } from '../../../shared/plugin-api/renderer';
import type {
  ActionEvent,
  ActionTemplate,
  ActionTrigger,
  AppConfig,
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

/** Patches one section of the live config (read-modify-write). */
async function patchSection<K extends keyof AppConfig>(
  api: DreyPluginApi,
  key: K,
  change: (section: AppConfig[K]) => void,
): Promise<void> {
  const config = await api.appConfig.get();
  const section = structuredClone(config[key]);
  change(section);
  await api.appConfig.patch({ [key]: section } as unknown as Partial<AppConfig>);
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

export function actionsSettingsPage(
  api: DreyPluginApi,
  onPatched: () => void,
): PluginSettingsPageContrib {
  return {
    id: 'actions',
    label: 'Actions',
    hint: 'Prompt templates & triggers',
    mount(root) {
      const patchActions = (
        change: (section: AppConfig['actions']) => void,
      ): Promise<void> => patchSection(api, 'actions', change).then(onPatched);
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
      const addTriggerRow = el('div', 'add-trigger');
      triggersSection.appendChild(addTriggerRow);
      root.appendChild(triggersSection);

      const templatesSection = el('section');
      templatesSection.appendChild(el('h3', undefined, 'Template library'));
      templatesSection.appendChild(
        el(
          'p',
          'section-hint',
          'A template is a name, a prompt, and the kind of change it makes. “Autotagging” suggests tags for the entry drawer; “Update summary” rebuilds a master document’s Summary section.',
        ),
      );
      const templateList = el('ul', 'templates');
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

      let openTemplateId: string | null = null;
      let config: AppConfig | null = null;

      const templateName = (id: string): string =>
        config?.actions.templates.find((t) => t.id === id)?.name ?? '(deleted template)';

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
        const item = el('li', 'template');
        const headRow = el('div', 'template-head');

        const nameInput = el('input', 'template-name') as HTMLInputElement;
        nameInput.type = 'text';
        nameInput.value = template.name;
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
          const prompt = el('textarea', 'template-prompt') as HTMLTextAreaElement;
          prompt.rows = 6;
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
        config = await api.appConfig.get();

        triggerList.textContent = '';
        if (config.actions.triggers.length === 0) {
          triggerList.appendChild(el('p', 'empty', 'No triggers. Add one below.'));
        }
        for (const trigger of config.actions.triggers) {
          triggerList.appendChild(triggerRow(trigger));
        }
        addTriggerRow.textContent = '';

        const templateSelect = el('select') as HTMLSelectElement;
        for (const template of config.actions.templates) {
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
        const addBtn = el('button', 'ghost', 'Add trigger') as HTMLButtonElement;
        addBtn.type = 'button';
        addBtn.addEventListener('click', () => {
          const templateId = templateSelect.value || config?.actions.templates[0]?.id;
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
        for (const template of config.actions.templates) {
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
