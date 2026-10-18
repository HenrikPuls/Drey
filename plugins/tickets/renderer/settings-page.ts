import type { DreyPluginApi, PluginSettingsPageContrib } from '../../../shared/plugin-api/renderer';
import { parseHandover, type BoardSnapshot, type PipelinePhase } from '../shared/tickets';

/**
 * Settings — Tickets (M85): the pipeline stays the configurable file
 * (`_meta/pipeline.md`), this page is its editor. One row per column:
 * the worker makes the column an automatic step (unset = manual), model
 * and pool size shape the worker pool, the prompt ref names the
 * `_meta/prompts/` file. Every change is written through the main
 * side's `columns` mutation — one commit per change — and the board
 * follows on refresh. The fleet defaults are the plugin's own config
 * and apply on restart.
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

      // --- the pipeline's columns (pipeline.md; one commit per change) ---
      body.appendChild(sectionHead('Pipeline columns'));
      body.appendChild(
        el(
          'p',
          'sub',
          'Lives in tickets/_meta/pipeline.md — one commit per change. Model pins the worker model (OpenCode: providerID/modelID), Pool is the parallel-run count, Prompt names tickets/_meta/prompts/<ref>.md.',
        ),
      );
      const rows = el('div', 'rows');
      body.appendChild(rows);
      void (api.backend.invoke('board') as Promise<BoardSnapshot>).then((snap) => {
        for (const phase of snap.pipeline) {
          rows.append(phaseRow(api, phase));
        }
      });
      return () => undefined;
    },
  };
}

function sectionHead(title: string): HTMLElement {
  return el('h3', 'section-head', title);
}

function phaseRow(api: DreyPluginApi, phase: PipelinePhase): HTMLElement {
  const row = el('div', 'row tickets-settings-row');
  const change = (payload: Record<string, unknown>): void => {
    void api.backend.invoke('columns', { phase: phase.id, ...payload }).catch(() => undefined);
  };

  // The worker makes the column automatic. A hand-edited handover pin
  // without a worker: key still marks it — shown, not guessable away.
  const handover = parseHandover(phase.handover);
  const auto = handover.mode === 'agent';
  const worker = el('select') as HTMLSelectElement;
  worker.setAttribute('aria-label', `Worker for ${phase.title}`);
  for (const [value, label] of WORKER_CHOICES) {
    const option = el('option', undefined, label) as HTMLOptionElement;
    option.value = value;
    if (value === (phase.worker ?? '')) {
      option.selected = true;
    }
    worker.append(option);
  }
  if (phase.worker === null && auto) {
    const option = el('option', undefined, `Handover pin (${handover.worker ?? 'default'})`) as HTMLOptionElement;
    option.value = `@${handover.worker ?? ''}`;
    option.selected = true;
    worker.append(option);
  }
  worker.addEventListener('change', () => {
    change({ worker: worker.value.startsWith('@') ? undefined : worker.value });
  });

  const model = el('input', 'mono-input') as HTMLInputElement;
  model.type = 'text';
  model.spellcheck = false;
  model.value = phase.model ?? '';
  model.setAttribute('aria-label', `Model pin for ${phase.title}`);
  model.addEventListener('change', () => change({ model: model.value }));

  const workers = el('input', 'mono-input') as HTMLInputElement;
  workers.type = 'number';
  workers.min = '1';
  workers.max = '16';
  workers.step = '1';
  workers.value = String(phase.workers);
  workers.setAttribute('aria-label', `Pool size for ${phase.title}`);
  workers.addEventListener('change', () => {
    const parsed = Number(workers.value);
    change({ workers: Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : null });
  });

  const prompt = el('input', 'mono-input') as HTMLInputElement;
  prompt.type = 'text';
  prompt.spellcheck = false;
  prompt.value = phase.prompt ?? '';
  prompt.setAttribute('aria-label', `Prompt ref for ${phase.title}`);
  prompt.addEventListener('change', () => change({ prompt: prompt.value }));

  row.append(
    named(phase.title),
    fieldLabel('Worker', worker),
    fieldLabel('Model', model),
    fieldLabel('Pool', workers),
    fieldLabel('Prompt', prompt),
  );
  return row;
}

function named(name: string): HTMLElement {
  const span = el('span', 'name', name);
  span.classList.add('tickets-settings-phase');
  return span;
}

function fieldLabel(label: string, control: HTMLElement): HTMLElement {
  const wrap = el('label', 'tickets-settings-field');
  const span = el('span', 'tickets-settings-label', label);
  wrap.append(span, control);
  return wrap;
}

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
