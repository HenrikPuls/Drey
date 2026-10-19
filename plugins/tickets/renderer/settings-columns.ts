import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { parseHandover, stripPhasePrefix, type FolderStatus, type PipelinePhase } from '../shared/tickets';
import { el, iconButton, mutate, textButton } from './settings-dom';
import { modelPicker } from './settings-model-picker';
import { canMove, dropIndex, folderNumber, moveItem } from './settings-order';

/**
 * Settings → Tickets, the pipeline (req-50): one sortable table, a row
 * per column in pipeline order. Drag a row by its grip or press Alt+↑/↓
 * on a focused row; the first (capture) and last (terminal) phase are
 * pinned. A move rewrites pipeline.md and renumbers the phase folders in
 * one commit (main's `reorderPhases`); Undo is the reverse move. A
 * column with a worker runs itself — its model, pool and prompt are
 * edited in place; a manual column is the owner's checkpoint and shows
 * dashes there.
 */

const WORKER_CHOICES: ReadonlyArray<readonly [string, string]> = [
  ['', 'Manual'],
  ['opencode', 'OpenCode'],
  ['claude-code', 'Claude Code'],
];

export interface ColumnsState {
  readonly pipeline: readonly PipelinePhase[];
  readonly folders: FolderStatus;
  readonly promptRefs: readonly string[];
  readonly defaultWorker: string;
}

export interface ColumnsSection {
  readonly root: HTMLElement;
  /** Re-renders from fresh data — deferred while a control in the table has focus. */
  update(state: ColumnsState): void;
}

/** The prompt a column runs: its `prompt:` key, else the handover's ref. */
export function effectivePrompt(phase: PipelinePhase): string | null {
  if (phase.prompt !== null && phase.prompt.trim() !== '') {
    return phase.prompt.trim();
  }
  return parseHandover(phase.handover).promptRef;
}

export function createColumnsSection(api: DreyPluginApi, reload: () => Promise<void>): ColumnsSection {
  const root = el('section', 'tset-section');
  root.setAttribute('aria-labelledby', 'tset-pipeline-head');

  const head = el('div', 'tset-section-head');
  const title = el('h3', undefined, 'Pipeline');
  title.id = 'tset-pipeline-head';
  const count = el('span', 'tset-muted');
  head.append(title, count);

  const banner = el('div', 'callout warn tset-banner');
  banner.setAttribute('role', 'status');
  banner.hidden = true;

  const hint = el(
    'p',
    'section-hint',
    'Drag a row by its grip, or press Alt+↑/↓ on a focused row, to reorder. A move rewrites pipeline.md and renumbers the phase folders in one commit. Inbox and Done stay first and last.',
  );

  const table = el('div', 'tset-table');
  table.setAttribute('role', 'table');
  table.setAttribute('aria-label', 'Pipeline columns');
  const status = el('div', 'tset-status');
  status.setAttribute('aria-live', 'polite');
  const foot = el(
    'p',
    'section-hint',
    'Model lists come from the worker CLI; an id it does not list can always be typed. Pool is how many tickets the column works on at once.',
  );
  root.append(head, banner, hint, table, status, foot);

  let state: ColumnsState | null = null;
  let renderedKey = '';
  let pending = false;

  const say = (text: string, kind: 'ok' | 'error' | 'busy', undo?: () => void): void => {
    status.replaceChildren();
    status.className = `tset-status tset-status-${kind}`;
    if (text === '') {
      return;
    }
    if (kind === 'ok') {
      status.append(api.ui.icon('check', 14));
    } else if (kind === 'error') {
      status.append(api.ui.icon('triangle-alert', 14));
    }
    status.append(el('span', undefined, text));
    if (undo !== undefined) {
      const button = textButton('Undo');
      button.addEventListener('click', undo);
      status.append(button);
    }
  };

  const reorder = async (order: readonly string[], movedId: string, previous: readonly string[] | null): Promise<void> => {
    const phase = state?.pipeline.find((p) => p.id === movedId);
    const index = order.indexOf(movedId);
    say('Moving…', 'busy');
    const result = await mutate(api, 'reorderPhases', { order });
    if (!result.ok) {
      say(`Not moved. ${capitalize(result.error ?? 'The move failed.')}`, 'error');
      return;
    }
    const folders = result.moved ?? 0;
    const text =
      `${phase?.title ?? movedId} moved to position ${folderNumber(index)}. ` +
      `${folders === 0 ? 'No folder' : folders === 1 ? '1 folder' : `${folders} folders`} renumbered.` +
      (result.warning !== undefined ? ` ${capitalize(result.warning)}.` : '');
    say(text, 'ok', previous === null ? undefined : () => void reorder(previous, movedId, null));
    await reload();
  };

  const renderBanner = (folders: FolderStatus): void => {
    banner.replaceChildren();
    banner.hidden = folders.moves.length === 0;
    if (banner.hidden) {
      return;
    }
    const text = el('div', 'tset-banner-text');
    const n = folders.moves.length;
    const examples = folders.moves.slice(0, 2).map((m) => `${m.from} → ${m.to}`).join(', ');
    text.append(
      el('strong', undefined, 'Phase folders are not numbered'),
      el(
        'span',
        undefined,
        `${n === 1 ? '1 folder does' : `${n} folders do`} not carry ${n === 1 ? 'its' : 'their'} column number yet (${examples}${n > 2 ? ', …' : ''}). Numbering renames them in one commit; tickets keep their columns.`,
      ),
    );
    const button = textButton('Number folders', 'primary');
    button.addEventListener('click', () => {
      button.disabled = true;
      void mutate(api, 'numberFolders').then(async (result) => {
        button.disabled = false;
        if (result.ok) {
          const moved = result.moved ?? 0;
          say(
            `${moved === 1 ? '1 folder' : `${moved} folders`} renumbered.` +
              (result.warning !== undefined ? ` ${capitalize(result.warning)}.` : ''),
            'ok',
          );
          await reload();
        } else {
          say(`Not renumbered. ${capitalize(result.error ?? '')}`, 'error');
        }
      });
    });
    banner.append(text, button);
  };

  const render = (): void => {
    if (state === null) {
      return;
    }
    const current = state;
    const pipeline = current.pipeline;
    const order = pipeline.map((p) => p.id);
    const auto = pipeline.filter((p) => parseHandover(p.handover).mode === 'agent').length;
    count.textContent = `${pipeline.length} columns · ${auto} ${auto === 1 ? 'runs' : 'run'} itself`;
    renderBanner(current.folders);

    table.replaceChildren();
    const header = el('div', 'tset-row tset-row-head');
    header.setAttribute('role', 'row');
    for (const label of ['', 'No.', 'Column', 'Worker', 'Model', 'Pool', 'Prompt', '']) {
      const cell = el('span', 'tset-th', label);
      cell.setAttribute('role', 'columnheader');
      header.append(cell);
    }
    table.append(header);
    if (pipeline.length === 0) {
      table.append(el('p', 'empty', 'The pipeline is empty or does not parse — see tickets/_meta/pipeline.md.'));
      return;
    }

    const rows: HTMLElement[] = [];
    pipeline.forEach((phase, index) => {
      const row = phaseRow(api, current, phase, index, pipeline.length);
      rows.push(row.element);
      table.append(row.element);
      if (!row.movable) {
        return;
      }
      row.element.addEventListener('keydown', (event) => {
        if (event.target !== row.element || !event.altKey) {
          return;
        }
        const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
        if (step === 0) {
          return;
        }
        event.preventDefault();
        if (canMove(order.length, index, index + step)) {
          void reorder(moveItem(order, index, index + step), phase.id, order);
        }
      });
      row.grip.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) {
          return;
        }
        event.preventDefault();
        row.grip.setPointerCapture(event.pointerId);
        const mids = rows.map((r) => {
          const rect = r.getBoundingClientRect();
          return rect.top + rect.height / 2;
        });
        const startY = event.clientY;
        let to = index;
        row.element.classList.add('tset-dragging');
        const onMove = (move: PointerEvent): void => {
          row.element.style.transform = `translateY(${move.clientY - startY}px)`;
          to = dropIndex(mids, move.clientY, index);
          rows.forEach((r, i) => {
            r.classList.toggle('tset-drop-before', i === to && to < index);
            r.classList.toggle('tset-drop-after', i === to && to > index);
          });
        };
        const onUp = (): void => {
          row.grip.removeEventListener('pointermove', onMove);
          row.grip.removeEventListener('pointerup', onUp);
          row.grip.removeEventListener('pointercancel', onUp);
          row.element.classList.remove('tset-dragging');
          row.element.style.transform = '';
          rows.forEach((r) => r.classList.remove('tset-drop-before', 'tset-drop-after'));
          if (canMove(order.length, index, to)) {
            void reorder(moveItem(order, index, to), phase.id, order);
          }
        };
        row.grip.addEventListener('pointermove', onMove);
        row.grip.addEventListener('pointerup', onUp);
        row.grip.addEventListener('pointercancel', onUp);
      });
    });
  };

  // A refresh never pulls a control out from under the owner's hands.
  root.addEventListener('focusout', (event) => {
    if (pending && !table.contains(event.relatedTarget as Node | null)) {
      pending = false;
      render();
    }
  });

  return {
    root,
    update: (next) => {
      state = next;
      const key = JSON.stringify([next.pipeline, next.folders, next.promptRefs, next.defaultWorker]);
      if (key === renderedKey) {
        return;
      }
      renderedKey = key;
      if (table.contains(document.activeElement)) {
        pending = true;
        renderBanner(next.folders);
        return;
      }
      render();
    },
  };
}

interface PhaseRow {
  readonly element: HTMLElement;
  readonly grip: HTMLElement;
  readonly movable: boolean;
}

function phaseRow(
  api: DreyPluginApi,
  state: ColumnsState,
  phase: PipelinePhase,
  index: number,
  length: number,
): PhaseRow {
  const handover = parseHandover(phase.handover);
  const auto = handover.mode === 'agent';
  const movable = index > 0 && index < length - 1;
  const row = el('div', `tset-row${auto ? '' : ' tset-row-manual'}`);
  row.setAttribute('role', 'row');
  row.tabIndex = 0;
  row.setAttribute(
    'aria-label',
    `${phase.title}, position ${folderNumber(index)}${movable ? '. Alt+Up or Alt+Down moves it' : ''}`,
  );

  const rowStatus = el('span', 'tset-cell-status');
  const change = (payload: Record<string, unknown>): void => {
    rowStatus.replaceChildren();
    void mutate(api, 'columns', { phase: phase.id, ...payload }).then((result) => {
      rowStatus.replaceChildren(api.ui.icon(result.ok ? 'check' : 'triangle-alert', 14));
      rowStatus.classList.toggle('tset-error', !result.ok);
      const text = result.ok ? (result.warning ?? 'Saved') : (result.error ?? 'Not saved');
      rowStatus.title = capitalize(text);
      rowStatus.setAttribute('aria-label', capitalize(text));
    });
  };

  // Order cell: a grip, or a pin for the capture target and the terminal.
  const grip = el('span', movable ? 'tset-grip' : 'tset-pin');
  const gripLabel = movable
    ? `Drag ${phase.title} to reorder`
    : index === 0
      ? 'Capture target — always first'
      : 'Terminal — always last';
  grip.title = gripLabel;
  grip.setAttribute('aria-label', gripLabel);
  grip.append(api.ui.icon(movable ? 'grip-vertical' : 'pin', 14));

  const number = el('span', 'tset-num', folderNumber(index));
  const name = el('span', 'tset-name');
  const dir = currentDir(state.folders, phase.id, index);
  const meta = el('span', 'tset-name-meta');
  meta.append(
    el('span', `tset-chip ${auto ? 'tset-chip-auto' : 'tset-chip-manual'}`, auto ? 'Runs itself' : 'Checkpoint'),
    el('span', 'tset-name-dir', dir),
  );
  name.append(el('span', 'tset-name-title', phase.title), meta);
  name.title = `${phase.title} — tickets/${dir}`;

  const worker = el('select');
  worker.setAttribute('aria-label', `Worker for ${phase.title}`);
  for (const [value, label] of WORKER_CHOICES) {
    worker.append(Object.assign(el('option', undefined, label), { value, selected: value === (phase.worker ?? '') }));
  }
  if (phase.worker === null && auto) {
    // A hand-written `agent …@worker` handover without a worker: key — shown, not guessed away.
    worker.append(
      Object.assign(el('option', undefined, `Handover pin (${handover.worker ?? 'default'})`), {
        value: '@pin',
        selected: true,
      }),
    );
  }
  worker.addEventListener('change', () => {
    if (worker.value !== '@pin') {
      change({ worker: worker.value });
    }
  });

  const cells: HTMLElement[] = [grip, number, name, cell(worker)];
  if (auto) {
    const workerOf = (): string => phase.worker ?? handover.worker ?? state.defaultWorker;
    const model = modelPicker(api, phase.title, phase.model ?? '', workerOf, (value) => change({ model: value }));

    const pool = el('input');
    pool.type = 'number';
    pool.min = '1';
    pool.max = '16';
    pool.step = '1';
    pool.value = String(phase.workers);
    pool.setAttribute('aria-label', `Pool size for ${phase.title}`);
    pool.addEventListener('change', () => {
      const parsed = Number(pool.value);
      change({ workers: Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : null });
    });

    const prompt = el('select', 'mono-input');
    prompt.setAttribute('aria-label', `Prompt for ${phase.title}`);
    const ref = effectivePrompt(phase) ?? '';
    const refs = [...state.promptRefs];
    if (ref !== '' && !refs.includes(ref)) {
      refs.push(ref);
    }
    if (ref === '') {
      prompt.append(Object.assign(el('option', undefined, 'None'), { value: '', selected: true }));
    }
    for (const option of refs) {
      const missing = !state.promptRefs.includes(option);
      prompt.append(
        Object.assign(el('option', undefined, missing ? `${option} (file missing)` : option), {
          value: option,
          selected: option === ref,
        }),
      );
    }
    prompt.title = ref;
    prompt.addEventListener('change', () => change({ prompt: prompt.value }));
    cells.push(cell(model.root), cell(pool), cell(prompt));
  } else {
    for (const label of ['No model', 'No pool', 'No prompt']) {
      const dash = el('span', 'tset-dash', '—');
      dash.setAttribute('aria-label', label);
      cells.push(dash);
    }
  }
  cells.push(rowStatus);
  for (const c of cells) {
    c.setAttribute('role', 'cell');
  }
  row.append(...cells);
  return { element: row, grip, movable };
}

function cell(control: HTMLElement): HTMLElement {
  const wrap = el('span', 'tset-cell');
  wrap.append(control);
  return wrap;
}

/** The folder a phase lives in today: a pending rename's source, else its derived name. */
function currentDir(folders: FolderStatus, id: string, index: number): string {
  const pending = folders.moves.find((m) => stripPhasePrefix(m.from) === id);
  return pending?.from ?? `${folderNumber(index)}-${id}`;
}

function capitalize(text: string): string {
  return text === '' ? text : text[0]!.toUpperCase() + text.slice(1);
}
