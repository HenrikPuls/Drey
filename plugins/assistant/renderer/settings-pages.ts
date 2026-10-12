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
    description: 'The prompts the assistant can run on a note, and when each one runs.',
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
        config = await api.appConfig.get();

        triggerList.textContent = '';
        if (config.actions.triggers.length === 0) {
          triggerList.appendChild(el('li', 'empty', 'No triggers. Add one below.'));
        }
        for (const trigger of config.actions.triggers) {
          triggerList.appendChild(triggerRow(trigger));
        }
        addTriggerRow.textContent = '';

        const templateSelect = el('select') as HTMLSelectElement;
        templateSelect.setAttribute('aria-label', 'Template for the new trigger');
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
        eventSelect.setAttribute('aria-label', 'Event for the new trigger');
        const addBtn = el('button', 'ghost small', 'Add trigger') as HTMLButtonElement;
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

// -- Semantic vault retrieval page ------------------------------------------

interface SemanticVaultStatusView {
  id: string;
  name: string;
  active: boolean;
  sections: number;
  stale: boolean;
  building: { done: number; total: number } | null;
}

interface SemanticStatusView {
  enabled: boolean;
  model: string;
  topK: number;
  minScore: number;
  ready: boolean;
  vaults: SemanticVaultStatusView[];
}

/**
 * The "Assistant retrieval" settings page (ADR-0055): the semantic index
 * config (enable, model, k, score threshold) plus per-vault index status
 * and rebuild buttons. Saves into the plugin's own config store
 * (`api.settings`), then pokes the main side via `semantic:configChanged`.
 */
export function retrievalSettingsPage(api: DreyPluginApi): PluginSettingsPageContrib {
  return {
    id: 'assistant-retrieval',
    label: 'Assistant retrieval',
    hint: 'Vault context for the assistant',
    description:
      'With the Vault chip on, each assistant question retrieves the most similar note sections from the vault and adds them as context.',
    mount(root) {
      root.classList.add('assistant-actions-settings', 'assistant-retrieval-settings');
      let progressUnsubscribe: (() => void) | null = api.backend.on('semantic:updated', () => {
        void reload();
      });

      const master = el('section');
      master.appendChild(el('h3', undefined, 'Vault context'));
      const enableRow = el('label', 'switch-row');
      const enableBox = el('input') as HTMLInputElement;
      enableBox.type = 'checkbox';
      enableBox.addEventListener('change', () => {
        void api.settings
          .set('semantic.enabled', enableBox.checked)
          .then(() => api.backend.invoke('semantic:configChanged'))
          .then(reload);
      });
      const enableText = el('span');
      enableText.append(
        el('span', 'switch-label', 'Enable vault context'),
        el(
          'span',
          'switch-hint',
          'No tool calls, a small fixed context. The first build embeds every note section — it runs in the background, and the model downloads once.',
        ),
      );
      enableRow.append(enableBox, enableText);
      master.appendChild(enableRow);
      root.appendChild(master);

      const tuning = el('section');
      tuning.appendChild(el('h3', undefined, 'Retrieval'));
      const tuningHint = el(
        'p',
        'section-hint',
        'How much context one question may add: the number of sections (k) and the similarity cutoff. Keep both small for small models.',
      );
      tuning.appendChild(tuningHint);

      const modelRow = el('div', 'field');
      const modelLabel = el('label', undefined, 'Embedding model (Hugging Face id)');
      modelLabel.htmlFor = 'assistant-retrieval-model';
      modelRow.append(modelLabel);
      const modelInput = el('input', 'mono-input') as HTMLInputElement;
      modelInput.id = 'assistant-retrieval-model';
      modelInput.type = 'text';
      modelInput.spellcheck = false;
      modelInput.placeholder = 'Xenova/multilingual-e5-small';
      modelInput.addEventListener('change', () => {
        void api.settings
          .set('semantic.model', modelInput.value.trim())
          .then(() => api.backend.invoke('semantic:configChanged'))
          .then(reload);
      });
      modelRow.appendChild(modelInput);
      tuning.appendChild(modelRow);

      const numberRow = el('div', 'row assistant-retrieval-numbers');
      const kField = el('div', 'field');
      const kLabel = el('label', undefined, 'Sections per question (k)');
      kLabel.htmlFor = 'assistant-retrieval-k';
      kField.append(kLabel);
      const kInput = el('input') as HTMLInputElement;
      kInput.id = 'assistant-retrieval-k';
      kInput.type = 'number';
      kInput.min = '1';
      kInput.max = '8';
      kInput.addEventListener('change', () => {
        void api.settings
          .set('semantic.topK', Math.max(1, Math.min(8, Math.round(Number(kInput.value) || 4))))
          .then(() => api.backend.invoke('semantic:configChanged'))
          .then(reload);
      });
      kField.appendChild(kInput);
      numberRow.appendChild(kField);
      const scoreField = el('div', 'field');
      const scoreLabel = el('label', undefined, 'Minimum similarity (0–1)');
      scoreLabel.htmlFor = 'assistant-retrieval-score';
      scoreField.append(scoreLabel);
      const scoreInput = el('input') as HTMLInputElement;
      scoreInput.id = 'assistant-retrieval-score';
      scoreInput.type = 'number';
      scoreInput.min = '0';
      scoreInput.max = '1';
      scoreInput.step = '0.05';
      scoreInput.addEventListener('change', () => {
        const value = Number(scoreInput.value);
        void api.settings
          .set('semantic.minScore', Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.3)
          .then(() => api.backend.invoke('semantic:configChanged'))
          .then(reload);
      });
      scoreField.appendChild(scoreInput);
      numberRow.appendChild(scoreField);
      tuning.appendChild(numberRow);
      root.appendChild(tuning);

      const indexSection = el('section');
      indexSection.appendChild(el('h3', undefined, 'Index'));
      const vaultList = el('ul', 'rows');
      indexSection.appendChild(vaultList);
      root.appendChild(indexSection);

      async function reload(): Promise<void> {
        let status: SemanticStatusView;
        try {
          status = (await api.backend.invoke('semantic:status')) as SemanticStatusView;
        } catch {
          vaultList.textContent = '';
          vaultList.appendChild(el('li', 'empty', 'The retrieval backend is unavailable.'));
          return;
        }
        enableBox.checked = status.enabled;
        if (document.activeElement !== modelInput) {
          modelInput.value = status.model;
        }
        if (document.activeElement !== kInput) {
          kInput.value = String(status.topK);
        }
        if (document.activeElement !== scoreInput) {
          scoreInput.value = String(status.minScore);
        }

        vaultList.textContent = '';
        for (const vault of status.vaults) {
          const row = el('li', 'row');
          const name = el('span', 'name', vault.name);
          name.title = vault.id;
          row.appendChild(name);
          if (vault.active) {
            row.appendChild(el('span', 'badge', 'active'));
          }
          if (vault.building !== null) {
            row.appendChild(
              el('span', 'badge', `building ${vault.building.done}/${vault.building.total}`),
            );
          } else if (vault.stale) {
            row.appendChild(el('span', 'badge', 'model changed — rebuild'));
          } else {
            row.appendChild(
              el(
                'span',
                'field-hint',
                `${vault.sections} section${vault.sections === 1 ? '' : 's'}`,
              ),
            );
          }
          const rebuild = el('button', 'ghost small', 'Rebuild') as HTMLButtonElement;
          rebuild.type = 'button';
          rebuild.disabled = vault.building !== null;
          rebuild.addEventListener('click', () => {
            rebuild.disabled = true;
            void api.backend
              .invoke('semantic:rebuild', { vaultId: vault.id })
              .then(reload)
              .catch(() => reload());
          });
          row.appendChild(rebuild);
          vaultList.appendChild(row);
        }
      }

      void reload();
      return () => {
        progressUnsubscribe?.();
        progressUnsubscribe = null;
      };
    },
  };
}

/** `crypto.randomUUID` in the app; a cheap fallback for test contexts. */
function uid(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
