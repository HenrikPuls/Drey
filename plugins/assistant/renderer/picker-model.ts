import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { el } from './dom.js';
import { pickerFrame, showPicker } from './picker-frame.js';

/**
 * The ONE globally configured model (`llm.model` in the app config) — the
 * same value Settings -> LLM writes; the transport re-reads it per call,
 * so a change applies to the very next question.
 */
export interface ModelSetting {
  /** The model id; `null` when none is set, `undefined` while not loaded yet. */
  current(): string | null | undefined;
  refresh(): void;
  apply(value: string): Promise<void>;
}

export function createModelSetting(api: DreyPluginApi, onChange: () => void): ModelSetting {
  let model: string | null | undefined = undefined;
  return {
    current: () => model,
    refresh: () => {
      void api.appConfig
        .get()
        .then((config) => {
          model = config.llm.model;
          onChange();
        })
        .catch(() => {
          // The label stays as it is; the picker itself still works.
        });
    },
    apply: async (value) => {
      const next = value.trim();
      const current = await api.appConfig.get();
      await api.appConfig.patch({
        llm: { ...current.llm, model: next === '' ? null : next },
      });
      model = next === '' ? null : next;
      onChange();
    },
  };
}

/** The model picker: the provider's list (filterable) plus a field to type an id by hand. */
export function openModelPicker(api: DreyPluginApi, setting: ModelSetting): void {
  let close: () => void = () => undefined;
  let filter = '';
  let activeIndex = 0;
  let models: readonly string[] = [];
  let listingError: string | null = null;
  let canList = true;
  let filterInput: HTMLInputElement | null = null;
  let handInput: HTMLInputElement | null = null;

  const { box, headLabel, bodyArea } = pickerFrame('Model');

  const visibleModels = (): readonly string[] => {
    const query = filter.trim().toLowerCase();
    return models.filter(
      (model) => query === '' || model.toLowerCase().includes(query),
    );
  };

  const choose = (model: string): void => {
    void setting.apply(model);
    close();
  };

  const commitHand = (): void => {
    if (handInput !== null) {
      void setting.apply(handInput.value);
    }
    close();
  };

  const renderList = (): void => {
    const listBox = bodyArea.querySelector('.assistant-picker-list');
    if (!(listBox instanceof HTMLElement)) {
      return;
    }
    listBox.textContent = '';
    const visible = visibleModels();
    if (activeIndex >= visible.length) {
      activeIndex = Math.max(0, visible.length - 1);
    }
    visible.forEach((model, index) => {
      const rowEl = el(
        'div',
        'assistant-picker-row' + (index === activeIndex ? ' active' : ''),
        model,
      );
      if (model === setting.current()) {
        rowEl.classList.add('current');
      }
      rowEl.addEventListener('click', () => choose(model));
      rowEl.addEventListener('mousemove', () => {
        if (activeIndex !== index) {
          activeIndex = index;
          renderList();
        }
      });
      listBox.appendChild(rowEl);
    });
    if (visible.length === 0) {
      listBox.appendChild(
        el(
          'div',
          'assistant-picker-empty',
          models.length === 0
            ? 'The provider lists no models — type the id below.'
            : 'No matching model',
        ),
      );
    }
  };

  const buildBody = (): void => {
    bodyArea.textContent = '';
    filterInput = null;
    handInput = null;
    if (listingError !== null) {
      bodyArea.appendChild(el('div', 'assistant-picker-note', listingError));
    }
    if (canList && models.length > 0) {
      filterInput = el('input', 'assistant-picker-input') as HTMLInputElement;
      filterInput.type = 'text';
      filterInput.placeholder = 'Filter models …';
      filterInput.addEventListener('input', () => {
        filter = filterInput?.value ?? '';
        activeIndex = 0;
        renderList();
      });
      bodyArea.appendChild(filterInput);
    }
    const listBox = el('div', 'assistant-picker-list');
    bodyArea.appendChild(listBox);
    const wrap = el('div', 'assistant-picker-hand');
    handInput = el('input', 'assistant-picker-input') as HTMLInputElement;
    handInput.type = 'text';
    handInput.placeholder = 'Model id, typed by hand …';
    handInput.value = setting.current() ?? '';
    handInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        commitHand();
      }
    });
    const applyBtn = el('button', 'assistant-picker-use', 'Use') as HTMLButtonElement;
    applyBtn.type = 'button';
    applyBtn.addEventListener('click', commitHand);
    wrap.append(handInput, applyBtn);
    bodyArea.appendChild(wrap);
    renderList();
    window.setTimeout(() => (filterInput ?? handInput)?.focus(), 0);
  };

  box.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.target !== filterInput) {
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const len = visibleModels().length;
      if (len > 0) {
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        activeIndex = (activeIndex + delta + len) % len;
        renderList();
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const model = visibleModels()[activeIndex];
      if (model !== undefined) {
        choose(model);
      }
    }
  });

  close = showPicker(api, box);

  // Re-fetched on every open: it reflects whatever provider is active
  // right now, and a switch in Settings is picked up without a restart.
  void api.llm
    .listModels()
    .then((listing) => {
      headLabel.textContent = listing.providerLabel;
      models = listing.models;
      canList = listing.modelListing;
      listingError = listing.error;
      buildBody();
    })
    .catch((err) => {
      // listModels resolves errors into `error`; this is belt and braces.
      listingError = err instanceof Error ? err.message : String(err);
      canList = false;
      models = [];
      buildBody();
    });
}
