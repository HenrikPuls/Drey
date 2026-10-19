import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { el } from './settings-dom';

interface WorkerModels {
  readonly models: readonly string[];
  readonly note: string | null;
}

export interface ModelPicker {
  readonly root: HTMLElement;
  setDisabled(disabled: boolean): void;
  reload(): void;
}

/**
 * A combobox over what the worker CLI offers (req-46): type to filter,
 * arrows and Enter to choose, Escape to close. The text stays free — a
 * model the list does not know (a new release, a custom provider) is
 * simply typed — and the value is saved when the field is left or a row
 * is chosen.
 */
export function modelPicker(
  api: DreyPluginApi,
  title: string,
  initial: string,
  workerOf: () => string,
  onCommit: (value: string) => void,
): ModelPicker {
  const root = el('div', 'tset-combo');
  const input = el('input', 'mono-input');
  input.type = 'text';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.value = initial;
  input.title = initial;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-label', `Model for ${title}`);
  const list = el('ul', 'tset-combo-list');
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  root.append(input, list);

  let models: readonly string[] = [];
  let note = '';
  let loaded = false;
  let committed = initial;
  let active = -1;
  let typed = false;
  let shown: string[] = [];

  const load = (): void => {
    loaded = false;
    void (api.backend.invoke('models', { worker: workerOf() }) as Promise<WorkerModels>)
      .then((res) => {
        models = res.models;
        note = res.note ?? '';
        loaded = true;
        if (document.activeElement === input) {
          render();
        }
      })
      .catch(() => {
        models = [];
        note = 'The model list is not available; type providerID/modelID.';
        loaded = true;
      });
  };

  const close = (): void => {
    typed = false;
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };

  const commit = (): void => {
    const value = input.value.trim();
    input.title = value;
    if (value !== committed) {
      committed = value;
      onCommit(value);
    }
  };

  const choose = (value: string): void => {
    input.value = value;
    close();
    commit();
  };

  const render = (): void => {
    // Opening the list shows everything; filtering starts with typing.
    const needle = typed ? input.value.trim().toLowerCase() : '';
    const matches = models.filter((m) => needle === '' || m.toLowerCase().includes(needle));
    shown = matches.slice(0, 60);
    list.replaceChildren();
    if (!loaded) {
      list.append(el('li', 'tset-combo-empty', 'Loading models…'));
    } else if (shown.length === 0) {
      list.append(
        el(
          'li',
          'tset-combo-empty',
          models.length === 0 ? note || 'No list available. Type the model id.' : 'No match. The typed text is kept.',
        ),
      );
    }
    let lastProvider = '';
    shown.forEach((m, index) => {
      const provider = m.includes('/') ? m.slice(0, m.indexOf('/')) : '';
      if (provider !== '' && provider !== lastProvider) {
        lastProvider = provider;
        list.append(el('li', 'tset-combo-group', provider));
      }
      const item = el('li', 'tset-combo-item', provider === '' ? m : m.slice(provider.length + 1));
      item.setAttribute('role', 'option');
      item.title = m;
      item.classList.toggle('active', index === active);
      item.classList.toggle('current', m === committed);
      // mousedown, not click: the input's blur would close the list first.
      item.addEventListener('mousedown', (event) => {
        event.preventDefault();
        choose(m);
      });
      list.append(item);
    });
    if (matches.length > shown.length) {
      list.append(el('li', 'tset-combo-empty', `${matches.length - shown.length} more — keep typing`));
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('focus', () => {
    if (!loaded) {
      load();
    }
    render();
  });
  input.addEventListener('input', () => {
    typed = true;
    active = -1;
    render();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (list.hidden) {
        render();
      }
      if (shown.length > 0) {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        active = (active + step + shown.length) % shown.length;
        render();
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const pick = shown[active];
      if (pick !== undefined && !list.hidden) {
        choose(pick);
      } else {
        close();
        commit();
      }
    } else if (event.key === 'Escape' && !list.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });
  input.addEventListener('blur', () => {
    close();
    commit();
  });

  return {
    root,
    setDisabled: (disabled) => {
      input.disabled = disabled;
    },
    reload: load,
  };
}
