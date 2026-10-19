import type { DreyPluginApi, PluginSettingsPageContrib } from '../../../shared/plugin-api/renderer';
import { parseHandover, type BoardSnapshot, type PipelinePhase } from '../shared/tickets';

/**
 * Settings — Tickets (M85, reworked in req-46): the pipeline stays the
 * configurable file (`_meta/pipeline.md`), this page is its editor. One
 * card per column: the worker makes the column an automatic step (unset =
 * manual), the model comes from a picker over what the worker CLI
 * offers (free text stays possible), pool size shapes the worker pool and
 * the prompt is chosen from the files in `_meta/prompts/`. Below the
 * columns, every prompt is an editor of its own — saved when the field is
 * left (or Ctrl+S), one commit per save, like every other change here.
 * The fleet defaults are the plugin's own config and apply on restart.
 */

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

const WORKER_CHOICES: ReadonlyArray<readonly [string, string]> = [
  ['', 'Manual column'],
  ['opencode', 'OpenCode'],
  ['claude-code', 'Claude Code'],
];

interface PromptEntry {
  readonly ref: string;
  readonly text: string;
  readonly seeded: boolean;
  readonly edited: boolean;
  readonly missing?: boolean;
}

interface WorkerModels {
  readonly models: readonly string[];
  readonly note: string | null;
}

interface MutationResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly warning?: string;
}

/** The prompt files, shared by the column pickers and the editors. */
class PromptStore {
  entries: readonly PromptEntry[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly api: DreyPluginApi) {}

  async load(): Promise<void> {
    try {
      this.entries = (await this.api.backend.invoke('prompts')) as PromptEntry[];
    } catch {
      this.entries = [];
    }
    for (const listener of this.listeners) {
      listener();
    }
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  /** `reload` rebuilds the lists; a plain text edit leaves them (and the editors' unsaved text) alone. */
  async save(payload: { ref: string; text?: string; reset?: boolean }, reload = true): Promise<MutationResult> {
    try {
      const result = (await this.api.backend.invoke('promptSave', payload)) as MutationResult;
      if (result.ok && reload) {
        await this.load();
      }
      return result;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

export function createTicketsSettingsPage(api: DreyPluginApi): PluginSettingsPageContrib {
  return {
    id: 'tickets',
    label: 'Tickets',
    hint: 'Board & fleet',
    description:
      'The tickets pipeline and its worker pools. A column with a worker runs itself; manual columns are your checkpoints.',
    mount: (body) => {
      // --- the fleet's own settings (plugin config; applied on restart) ---
      body.appendChild(sectionHead('Fleet'));
      const fleet = el('div', 'rows');
      fleet.append(
        field(
          'Default worker',
          selectConfig(api, 'defaultWorker', [
            ['opencode', 'OpenCode'],
            ['claude-code', 'Claude Code'],
          ]),
          'What an unpinned run takes when no level of the assignment names a worker. Applies on restart.',
        ),
        field(
          'Dispatched-run permissions',
          selectConfig(
            api,
            'autoPermissionMode',
            [
              ['accept-edits', 'Accept edits (asks before commands)'],
              ['bypass', 'Bypass permissions (unattended)'],
            ],
            'accept-edits',
          ),
          'The permission mode of chain-dispatched runs (no dialog to ask in). Applies on restart.',
        ),
        field(
          'Git executable',
          textConfig(api, 'gitPath'),
          'Empty uses the git on PATH; set the full path when it is elsewhere. Applies on restart.',
        ),
      );
      body.appendChild(fleet);

      const prompts = new PromptStore(api);

      // --- the pipeline's columns (pipeline.md; one commit per change) ---
      body.appendChild(sectionHead('Pipeline columns'));
      body.appendChild(
        el(
          'p',
          'sub',
          'Stored in tickets/_meta/pipeline.md, one commit per change. A column with a worker runs itself; the model pins that worker, the pool is how many runs go in parallel.',
        ),
      );
      const columns = el('div', 'tickets-cols');
      body.appendChild(columns);

      // --- the prompts (_meta/prompts/*.md) ---
      const promptsHead = sectionHead('Prompts');
      const addBtn = el('button', 'ghost', 'New prompt');
      addBtn.type = 'button';
      promptsHead.append(addBtn);
      body.appendChild(promptsHead);
      body.appendChild(
        el(
          'p',
          'sub',
          'The instructions a worker starts with. Saved to tickets/_meta/prompts/<name>.md when you leave the field; every save is one commit. A change reaches the next run, not one already running.',
        ),
      );
      const promptList = el('div', 'tickets-prompts');
      body.appendChild(promptList);
      const editors = new Map<string, HTMLDetailsElement>();
      const openEditor = (ref: string): void => {
        const details = editors.get(ref);
        if (details === undefined) {
          return;
        }
        details.open = true;
        details.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        details.querySelector('textarea')?.focus();
      };

      let usedBy = new Map<string, string[]>();
      const renderPrompts = (): void => {
        const wasOpen = new Set([...editors].filter(([, d]) => d.open).map(([ref]) => ref));
        promptList.replaceChildren();
        editors.clear();
        if (prompts.entries.length === 0) {
          promptList.append(el('p', 'sub', 'No prompt files yet. Create one, then pick it in a column.'));
        }
        for (const entry of prompts.entries) {
          const details = promptEditor(prompts, entry, usedBy.get(entry.ref) ?? []);
          details.open = wasOpen.has(entry.ref);
          editors.set(entry.ref, details);
          promptList.append(details);
        }
      };

      addBtn.addEventListener('click', () => {
        const form = el('div', 'tickets-newprompt');
        const input = el('input', 'mono-input') as HTMLInputElement;
        input.type = 'text';
        input.spellcheck = false;
        input.setAttribute('aria-label', 'New prompt name');
        const hint = el('span', 'tickets-hint');
        const create = el('button', 'primary', 'Create');
        create.type = 'button';
        const cancel = el('button', 'ghost', 'Cancel');
        cancel.type = 'button';
        form.append(input, create, cancel, hint);
        promptList.prepend(form);
        input.focus();
        cancel.addEventListener('click', () => form.remove());
        const submit = async (): Promise<void> => {
          const ref = input.value.trim().replace(/\.md$/i, '');
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(ref)) {
            hint.textContent = 'Letters, digits, dot, dash and underscore.';
            return;
          }
          if (prompts.entries.some((e) => e.ref === ref)) {
            hint.textContent = 'A prompt of that name exists.';
            return;
          }
          const starter = '# Instructions\n\n';
          const result = await prompts.save({ ref, text: starter });
          if (!result.ok) {
            hint.textContent = result.error ?? 'Could not create the prompt.';
            return;
          }
          openEditor(ref);
        };
        create.addEventListener('click', () => void submit());
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void submit();
          } else if (event.key === 'Escape') {
            form.remove();
          }
        });
      });

      const pickers = new Set<() => void>();
      prompts.onChange(() => {
        renderPrompts();
        for (const refresh of pickers) {
          refresh();
        }
      });

      void (async () => {
        const defaultWorker = ((await api.settings.get<string>('defaultWorker')) ?? '') || 'opencode';
        const snap = (await api.backend.invoke('board')) as BoardSnapshot;
        usedBy = new Map();
        for (const phase of snap.pipeline) {
          const ref = effectivePrompt(phase);
          if (ref !== null) {
            usedBy.set(ref, [...(usedBy.get(ref) ?? []), phase.title]);
          }
        }
        for (const phase of snap.pipeline) {
          const card = phaseCard(api, prompts, phase, defaultWorker, openEditor, pickers);
          columns.append(card);
        }
        await prompts.load();
      })();
      return () => undefined;
    },
  };
}

function effectivePrompt(phase: PipelinePhase): string | null {
  if (phase.prompt !== null && phase.prompt.trim() !== '') {
    return phase.prompt.trim();
  }
  return parseHandover(phase.handover).promptRef;
}

function sectionHead(title: string): HTMLElement {
  return el('h3', 'section-head', title);
}

// --- one column -----------------------------------------------------------

function phaseCard(
  api: DreyPluginApi,
  prompts: PromptStore,
  phase: PipelinePhase,
  defaultWorker: string,
  openEditor: (ref: string) => void,
  pickers: Set<() => void>,
): HTMLElement {
  const card = el('section', 'tickets-col-card');
  const status = el('span', 'tickets-hint');
  const change = (payload: Record<string, unknown>): Promise<boolean> =>
    (api.backend.invoke('columns', { phase: phase.id, ...payload }) as Promise<MutationResult>)
      .then((result) => {
        status.textContent = result.ok ? 'Saved' : (result.error ?? 'Not saved');
        status.classList.toggle('tickets-hint-error', !result.ok);
        return result.ok;
      })
      .catch(() => {
        status.textContent = 'Not saved';
        status.classList.add('tickets-hint-error');
        return false;
      });

  // The worker makes the column automatic. A hand-edited handover pin
  // without a worker: key still marks it — shown, not guessable away.
  const handover = parseHandover(phase.handover);
  let auto = handover.mode === 'agent';
  let worker = phase.worker ?? '';

  const head = el('header', 'tickets-col-head');
  const title = el('h4', 'tickets-col-title', phase.title);
  const badge = el('span', 'tickets-badge');
  head.append(title, badge, status);

  const workerSel = el('select') as HTMLSelectElement;
  workerSel.setAttribute('aria-label', `Worker for ${phase.title}`);
  for (const [value, label] of WORKER_CHOICES) {
    const option = el('option', undefined, label) as HTMLOptionElement;
    option.value = value;
    if (value === worker) {
      option.selected = true;
    }
    workerSel.append(option);
  }
  if (phase.worker === null && auto) {
    const option = el('option', undefined, `Handover pin (${handover.worker ?? 'default'})`) as HTMLOptionElement;
    option.value = `@${handover.worker ?? ''}`;
    option.selected = true;
    workerSel.append(option);
  }

  const pool = el('input') as HTMLInputElement;
  pool.type = 'number';
  pool.min = '1';
  pool.max = '16';
  pool.step = '1';
  pool.value = String(phase.workers);
  pool.setAttribute('aria-label', `Pool size for ${phase.title}`);
  pool.addEventListener('change', () => {
    const parsed = Number(pool.value);
    void change({ workers: Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : null });
  });

  const workerOfColumn = (): string => (worker !== '' ? worker : handover.worker ?? defaultWorker);
  const model = modelPicker(api, phase.title, phase.model ?? '', workerOfColumn, (value) => {
    void change({ model: value });
  });

  const promptSel = el('select') as HTMLSelectElement;
  promptSel.setAttribute('aria-label', `Prompt for ${phase.title}`);
  let promptRef = effectivePrompt(phase) ?? '';
  const renderPromptOptions = (): void => {
    promptSel.replaceChildren();
    const refs = prompts.entries.map((e) => e.ref);
    if (promptRef !== '' && !refs.includes(promptRef)) {
      refs.push(promptRef);
    }
    if (promptRef === '') {
      promptSel.append(Object.assign(el('option', undefined, 'None selected'), { value: '' }));
    }
    for (const ref of refs) {
      const missing = !prompts.entries.some((e) => e.ref === ref);
      const option = Object.assign(el('option', undefined, missing ? `${ref} (file missing)` : ref), {
        value: ref,
      });
      option.selected = ref === promptRef;
      promptSel.append(option);
    }
  };
  renderPromptOptions();
  const refreshPicker = (): void => renderPromptOptions();
  pickers.add(refreshPicker);
  promptSel.addEventListener('change', () => {
    promptRef = promptSel.value;
    void change({ prompt: promptRef });
  });
  const editBtn = el('button', 'ghost', 'Edit');
  editBtn.type = 'button';
  editBtn.title = 'Edit this prompt below';
  editBtn.setAttribute('aria-label', `Edit the prompt of ${phase.title}`);
  editBtn.addEventListener('click', () => {
    if (promptRef !== '') {
      openEditor(promptRef);
    }
  });

  const apply = (): void => {
    badge.textContent = auto ? 'Runs itself' : 'Your checkpoint';
    badge.classList.toggle('tickets-badge-auto', auto);
    card.classList.toggle('tickets-col-manual', !auto);
    for (const control of [pool, promptSel, editBtn]) {
      control.disabled = !auto;
    }
    model.setDisabled(!auto);
  };
  apply();

  workerSel.addEventListener('change', () => {
    const pin = workerSel.value.startsWith('@');
    worker = pin ? '' : workerSel.value;
    auto = pin || worker !== '';
    apply();
    model.reload();
    void change({ worker: pin ? undefined : worker }).then(async () => {
      // Turning a column automatic writes its handover; follow the ref it got.
      const snap = (await api.backend.invoke('board')) as BoardSnapshot;
      const fresh = snap.pipeline.find((p) => p.id === phase.id);
      if (fresh !== undefined) {
        promptRef = effectivePrompt(fresh) ?? '';
        renderPromptOptions();
      }
    });
  });

  card.append(
    head,
    grid(fieldLabel('Worker', workerSel), fieldLabel('Pool size', pool)),
    fieldLabel('Model', model.root),
    fieldLabel('Prompt', rowOf(promptSel, editBtn)),
  );
  return card;
}

function grid(...children: HTMLElement[]): HTMLElement {
  const wrap = el('div', 'tickets-grid');
  wrap.append(...children);
  return wrap;
}

function rowOf(...children: HTMLElement[]): HTMLElement {
  const wrap = el('div', 'tickets-inline');
  wrap.append(...children);
  return wrap;
}

function fieldLabel(label: string, control: HTMLElement): HTMLElement {
  const wrap = el('label', 'tickets-field');
  wrap.append(el('span', 'tickets-label', label), control);
  return wrap;
}

// --- the model picker -------------------------------------------------------

interface ModelPicker {
  readonly root: HTMLElement;
  setDisabled(disabled: boolean): void;
  reload(): void;
}

/**
 * A combobox over what the worker CLI offers: type to filter, arrows and
 * Enter to choose, Escape to close. The text stays free — a model the
 * list does not know (a new release, a custom provider) is simply typed —
 * and the value is saved when the field is left or a row is chosen.
 */
function modelPicker(
  api: DreyPluginApi,
  title: string,
  initial: string,
  workerOf: () => string,
  onCommit: (value: string) => void,
): ModelPicker {
  const root = el('div', 'tickets-combo');
  const input = el('input', 'mono-input') as HTMLInputElement;
  input.type = 'text';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.value = initial;
  input.placeholder = '';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-label', `Model for ${title}`);
  const list = el('ul', 'tickets-combo-list');
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  const note = el('p', 'tickets-hint tickets-combo-note');
  root.append(input, list, note);

  let models: readonly string[] = [];
  let loaded = false;
  let committed = initial;
  let active = -1;
  let typed = false;
  let shown: string[] = [];

  const load = (): void => {
    loaded = false;
    note.textContent = '';
    void (api.backend.invoke('models', { worker: workerOf() }) as Promise<WorkerModels>)
      .then((res) => {
        models = res.models;
        note.textContent = res.note ?? (res.models.length > 0 ? `${res.models.length} models` : '');
        loaded = true;
        if (document.activeElement === input) {
          render();
        }
      })
      .catch(() => {
        models = [];
        note.textContent = 'The model list is not available; type providerID/modelID.';
        loaded = true;
      });
  };

  const close = (): void => {
    typed = false;
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };

  const choose = (value: string): void => {
    input.value = value;
    close();
    commit();
  };

  const commit = (): void => {
    const value = input.value.trim();
    if (value !== committed) {
      committed = value;
      onCommit(value);
    }
  };

  const render = (): void => {
    // Opening the list shows everything; filtering starts with typing.
    const needle = typed ? input.value.trim().toLowerCase() : '';
    const matches = models.filter((m) => needle === '' || m.toLowerCase().includes(needle));
    shown = matches.slice(0, 60);
    list.replaceChildren();
    if (!loaded) {
      list.append(el('li', 'tickets-combo-empty', 'Loading models…'));
    } else if (shown.length === 0) {
      list.append(
        el(
          'li',
          'tickets-combo-empty',
          models.length === 0 ? 'No list available. Type the model id.' : 'No match. The typed text is kept.',
        ),
      );
    }
    let lastProvider = '';
    shown.forEach((m, index) => {
      const provider = m.includes('/') ? m.slice(0, m.indexOf('/')) : '';
      if (provider !== '' && provider !== lastProvider) {
        lastProvider = provider;
        list.append(el('li', 'tickets-combo-group', provider));
      }
      const item = el('li', 'tickets-combo-item', provider === '' ? m : m.slice(provider.length + 1));
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
      list.append(el('li', 'tickets-combo-empty', `${matches.length - shown.length} more — keep typing`));
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

  load();
  return {
    root,
    setDisabled: (disabled) => {
      input.disabled = disabled;
    },
    reload: load,
  };
}

// --- one prompt -------------------------------------------------------------

function promptEditor(store: PromptStore, entry: PromptEntry, usedBy: readonly string[]): HTMLDetailsElement {
  const details = el('details', 'tickets-prompt');
  const summary = el('summary', 'tickets-prompt-summary');
  summary.append(el('span', 'tickets-prompt-name', entry.ref));
  if (entry.missing === true) {
    summary.append(el('span', 'tickets-badge tickets-badge-warn', 'File missing'));
  } else if (entry.seeded && entry.edited) {
    summary.append(el('span', 'tickets-badge', 'Edited'));
  }
  summary.append(
    el(
      'span',
      'tickets-prompt-used',
      usedBy.length > 0 ? `Used by ${usedBy.join(', ')}` : 'Not used by a column',
    ),
  );
  details.append(summary);

  const area = el('textarea', 'mono-input tickets-prompt-text') as HTMLTextAreaElement;
  area.spellcheck = false;
  area.value = entry.text;
  area.rows = 18;
  area.setAttribute('aria-label', `Text of prompt ${entry.ref}`);

  const status = el('span', 'tickets-hint');
  const revert = el('button', 'ghost', 'Revert');
  revert.type = 'button';
  revert.title = 'Discard unsaved changes';
  const reset = el('button', 'ghost', 'Reset to default');
  reset.type = 'button';
  reset.title = 'Restore the text Drey ships for this prompt';
  reset.hidden = !entry.seeded;
  const bar = el('div', 'tickets-prompt-bar');
  bar.append(revert, reset, status);

  let saved = entry.text;
  let busy = false;
  const dirty = (): boolean => area.value !== saved;
  const sync = (): void => {
    revert.disabled = !dirty();
    status.classList.remove('tickets-hint-error');
    if (dirty()) {
      status.textContent = 'Unsaved — saves when you leave the field';
    }
  };
  const save = async (): Promise<void> => {
    if (!dirty() || busy) {
      return;
    }
    busy = true;
    status.textContent = 'Saving…';
    const result = await store.save({ ref: entry.ref, text: area.value }, false);
    busy = false;
    if (result.ok) {
      saved = area.value;
      status.textContent = result.warning === undefined ? 'Saved' : `Saved, ${result.warning}`;
    } else {
      status.textContent = result.error ?? 'Not saved';
      status.classList.add('tickets-hint-error');
    }
  };
  area.addEventListener('input', sync);
  area.addEventListener('blur', () => void save());
  area.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void save();
    }
  });
  revert.addEventListener('click', () => {
    area.value = saved;
    sync();
    status.textContent = 'Reverted';
  });
  let armed: ReturnType<typeof setTimeout> | null = null;
  reset.addEventListener('click', () => {
    // No native confirm in a sandboxed page: the second click confirms.
    if (armed === null) {
      reset.textContent = 'Click again to reset';
      status.textContent = 'Your version stays in the commit history.';
      armed = setTimeout(() => {
        armed = null;
        reset.textContent = 'Reset to default';
        status.textContent = '';
      }, 4000);
      return;
    }
    clearTimeout(armed);
    armed = null;
    reset.textContent = 'Reset to default';
    void store.save({ ref: entry.ref, reset: true }).then((result) => {
      if (!result.ok) {
        status.textContent = result.error ?? 'Not reset';
        status.classList.add('tickets-hint-error');
      }
    });
  });
  sync();
  status.textContent = '';
  details.append(area, bar);
  return details;
}

// --- plain config controls --------------------------------------------------

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrap = el('div', 'field');
  const labelEl = el('span', 'field-label', label);
  wrap.append(labelEl, control);
  if (hint !== undefined) {
    wrap.append(el('p', 'sub', hint));
  }
  return wrap;
}

function selectConfig(
  api: DreyPluginApi,
  key: string,
  choices: ReadonlyArray<readonly [string, string]>,
  fallback = '',
): HTMLSelectElement {
  const select = el('select') as HTMLSelectElement;
  for (const [value, label] of choices) {
    const option = el('option', undefined, label) as HTMLOptionElement;
    option.value = value;
    select.append(option);
  }
  void api.settings.get<string>(key).then((value) => {
    select.value = value ?? fallback;
  });
  select.addEventListener('change', () => {
    void api.settings.set(key, select.value).catch(() => undefined);
  });
  return select;
}

function textConfig(api: DreyPluginApi, key: string): HTMLInputElement {
  const input = el('input', 'mono-input') as HTMLInputElement;
  input.type = 'text';
  input.spellcheck = false;
  void api.settings.get<string>(key).then((value) => {
    input.value = value ?? '';
  });
  input.addEventListener('change', () => {
    void api.settings.set(key, input.value.trim()).catch(() => undefined);
  });
  return input;
}
