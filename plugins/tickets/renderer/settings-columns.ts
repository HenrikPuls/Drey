import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { parseHandover, slugifyPhaseId, stripPhasePrefix, type PipelinePhase } from '../shared/tickets';
import {
  addColumn,
  editColumn,
  mergeBuffer,
  moveColumn,
  promptOptions,
  removeColumn,
  startBuffer,
  toBatch,
  type ColumnsBuffer,
  type ColumnsState,
} from './settings-buffer';
import { el, iconButton, mutate, textButton } from './settings-dom';
import { modelPicker } from './settings-model-picker';
import { dropIndex, folderNumber } from './settings-order';

/**
 * Settings → Tickets, the pipeline (req-50, reworked T-0043): one
 * sortable table, a row per column in the buffered order. Drag a row by
 * its grip, press Alt+↑/↓ on a focused row, or use the row arrows;
 * **+** adds a column before the terminal (the id slugified from the
 * title, duplicates refused live), the armed **−** removes an empty
 * middle column. A column with a worker runs itself — its model, pool
 * and prompt are edited in place; a manual column is the owner's
 * checkpoint and shows dashes there. Nothing here commits: every edit
 * mutates the pure buffer (settings-buffer.ts) and is written as ONE
 * `tickets: columns …` commit when the dialog is left (`flush()`).
 */

const WORKER_CHOICES: ReadonlyArray<readonly [string, string]> = [
  ['', 'Manual'],
  ['opencode', 'OpenCode'],
  ['claude-code', 'Claude Code'],
];

export type { ColumnsState } from './settings-buffer';

export interface ColumnsSection {
  readonly root: HTMLElement;
  /** Merges fresh state into the buffer and re-renders — deferred while
   *  a control in the table has focus. */
  update(state: ColumnsState): void;
  /** The leave-commit: fire-and-forget, exactly once (the framework owns
   *  the close path; a refused batch reaches only the main-side log). */
  flush(): void;
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
  const dirtyChip = el('span', 'tset-chip tset-chip-dirty', 'Unsaved changes');
  dirtyChip.hidden = true;
  const addBtn = iconButton(api, 'plus', 'New column before the terminal');
  const tools = el('span', 'tset-head-tools');
  tools.append(addBtn);
  head.append(title, count, dirtyChip, tools);

  const banner = el('div', 'callout warn tset-banner');
  banner.setAttribute('role', 'status');
  banner.hidden = true;

  const hint = el(
    'p',
    'section-hint',
    'Drag a row by its grip, press Alt+↑/↓, or use the row arrows to reorder. + adds a column before the last; − removes an empty middle one. Everything you change here is buffered and written as one commit when you leave this page.',
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

  let buf: ColumnsBuffer | null = null;
  let renderedKey = '';
  let version = 0; // bumps on every local buffer mutation (the render key)
  let pending = false;
  let flushed = false;
  let armedRemove: string | null = null;
  let disarmTimer: ReturnType<typeof setTimeout> | null = null;
  let refusal: string | null = null;

  const say = (text: string, kind: 'ok' | 'error' | 'busy'): void => {
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
  };

  /** How many unsaved changes the status line counts (segments, not keys). */
  const dirtyCount = (): number => {
    if (buf === null) {
      return 0;
    }
    const batch = toBatch(buf);
    if (batch === null) {
      return 0;
    }
    const baseOrder = buf.base.pipeline.map((p) => p.id);
    const survivors = batch.order.filter((id) => baseOrder.includes(id));
    const reordered = !baseOrder.filter((id) => survivors.includes(id)).every((id, i) => survivors[i] === id);
    return batch.add.length + batch.remove.length + Object.keys(batch.patch).length + (reordered ? 1 : 0);
  };

  const syncChrome = (): void => {
    const n = dirtyCount();
    dirtyChip.hidden = n === 0;
    if (refusal !== null) {
      say(capitalize(refusal), 'error');
      return;
    }
    if (n > 0) {
      say(`${n} unsaved ${n === 1 ? 'change' : 'changes'} — written as one commit when you leave this page`, 'busy');
    } else {
      say('', 'busy');
    }
  };

  /** Every buffered mutation runs through here. */
  const afterEdit = (): void => {
    version++;
    refusal = null;
    syncChrome();
  };

  const renderBanner = (folders: ColumnsState['folders']): void => {
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

  // --- the add modal ------------------------------------------------------

  const openAddModal = (): void => {
    if (buf === null) {
      return;
    }
    const close = api.ui.showModal((host) => {
      const form = el('div', 'tickets-form');
      const field = el('label', 'tickets-form-field');
      field.append(el('span', 'tickets-form-label', 'Title'));
      const input = el('input', 'tickets-form-title');
      input.type = 'text';
      input.spellcheck = true;
      field.append(input);
      const preview = el('span', 'tset-newcol-preview');
      const error = el('span', 'tset-newcol-preview tset-error');
      const actions = el('div', 'tickets-form-actions');
      const cancel = textButton('Cancel');
      const create = textButton('Add column', 'primary');
      actions.append(cancel, create);
      form.append(el('h3', 'tickets-form-heading', 'New column'), field, preview, error, actions);
      host.append(form);

      const slugNow = (): string | null => slugifyPhaseId(input.value.trim());
      const sync = (): void => {
        const slug = slugNow();
        error.textContent = '';
        preview.textContent = slug === null ? '' : `id: ${slug}`;
        if (input.value.trim() === '') {
          return;
        }
        if (slug === null) {
          error.textContent = 'The title must yield an id of lowercase letters, digits and dashes, starting with a letter.';
        } else if (buf!.order.includes(slug)) {
          error.textContent = 'A column of that id exists.';
        }
      };
      const submit = (): void => {
        const slug = slugNow();
        if (slug === null || buf!.order.includes(slug)) {
          sync();
          input.focus();
          return;
        }
        addColumn(buf!, slug, input.value.trim());
        afterEdit();
        close();
        render();
        void reload();
      };
      input.addEventListener('input', sync);
      create.addEventListener('click', submit);
      cancel.addEventListener('click', close);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          submit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      });
      input.focus();
    });
  };
  addBtn.addEventListener('click', openAddModal);

  // --- the armed remove ---------------------------------------------------

  const disarm = (): void => {
    if (disarmTimer !== null) {
      clearTimeout(disarmTimer);
      disarmTimer = null;
    }
    armedRemove = null;
  };

  const armRemove = (id: string, button: HTMLButtonElement, label: string): void => {
    disarm();
    armedRemove = id;
    button.classList.add('tset-armed');
    button.title = `Confirm removing ${label}`;
    button.setAttribute('aria-label', `Confirm removing ${label}`);
    button.replaceChildren(api.ui.icon('triangle-alert', 14));
    disarmTimer = setTimeout(() => {
      const still = table.querySelector(`[data-id="${id}"] .tset-remove`);
      disarm();
      if (still instanceof HTMLButtonElement) {
        still.classList.remove('tset-armed');
        still.title = `Remove ${label}`;
        still.setAttribute('aria-label', `Remove ${label}`);
        still.replaceChildren(api.ui.icon('x', 14));
      }
    }, 4000);
  };

  const tryRemove = (id: string, button: HTMLButtonElement, label: string): void => {
    if (buf === null || armedRemove !== id) {
      armRemove(id, button, label);
      return;
    }
    disarm();
    const result = removeColumn(buf, id);
    if (!result.ok) {
      refusal = result.reason;
      syncChrome();
      return;
    }
    afterEdit();
    render();
    void reload();
  };

  // --- rows ----------------------------------------------------------------

  const render = (): void => {
    if (buf === null) {
      return;
    }
    const current = buf;
    const order = current.order;
    const auto = order.filter((id) => rowAuto(current, id)).length;
    count.textContent = `${order.length} columns · ${auto} ${auto === 1 ? 'runs' : 'run'} itself`;
    renderBanner(current.base.folders);

    table.replaceChildren();
    const header = el('div', 'tset-row tset-row-head');
    header.setAttribute('role', 'row');
    for (const label of ['', 'No.', 'Column', 'Worker', 'Model', 'Pool', 'Prompt', '']) {
      const cell = el('span', 'tset-th', label);
      cell.setAttribute('role', 'columnheader');
      header.append(cell);
    }
    table.append(header);
    if (order.length === 0) {
      table.append(el('p', 'empty', 'The pipeline is empty or does not parse — see tickets/_meta/pipeline.md.'));
      return;
    }

    const rows: HTMLElement[] = [];
    order.forEach((id, index) => {
      const row = phaseRow(api, current, id, index, order.length, {
        onEdit: (patch) => {
          if (buf === null) {
            return;
          }
          editColumn(buf, id, patch);
          afterEdit();
        },
        onWorkerChange: () => {
          render();
          (table.querySelector(`[data-id="${id}"] .tset-worker`) as HTMLElement | null)?.focus();
        },
        onMove: (to) => {
          if (buf === null || !moveColumn(buf, index, to)) {
            return false;
          }
          afterEdit();
          render();
          (table.querySelector(`[data-id="${id}"]`) as HTMLElement | null)?.focus();
          return true;
        },
        onRemove: (button, label) => tryRemove(id, button, label),
      }, armedRemove === id);
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
        if (index + step >= 1 && index + step <= order.length - 2) {
          row.move(index + step);
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
          row.move(to);
        };
        row.grip.addEventListener('pointermove', onMove);
        row.grip.addEventListener('pointerup', onUp);
        row.grip.addEventListener('pointercancel', onUp);
      });
    });
    dirtyChip.hidden = dirtyCount() === 0;
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
      if (buf === null) {
        buf = startBuffer(next);
      } else {
        mergeBuffer(buf, next);
      }
      const key = JSON.stringify([next.pipeline, next.folders, next.promptRefs, next.defaultWorker, next.counts, version]);
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
    flush: () => {
      if (flushed || buf === null) {
        return;
      }
      flushed = true;
      const batch = toBatch(buf);
      if (batch !== null) {
        // Fire-and-forget: the dispose is synchronous, a refused batch
        // reaches the main-side log, and the buffer is gone by design.
        void mutate(api, 'columns', batch);
      }
    },
  };
}

/** The buffered handover mode of a column: a buffered worker wins over
 *  the base handover (set → agent, cleared → manual). */
function rowAuto(buf: ColumnsBuffer, id: string): boolean {
  const raw = buf.patch[id];
  if (raw !== undefined && raw.worker !== undefined) {
    return (raw.worker ?? '') !== '';
  }
  const base = buf.base.pipeline.find((p) => p.id === id) ?? null;
  return base !== null && parseHandover(base.handover).mode === 'agent';
}

interface RowHandlers {
  onEdit(patch: import('../shared/tickets').ColumnFieldPatch): void;
  onWorkerChange(): void;
  onMove(to: number): boolean;
  onRemove(button: HTMLButtonElement, label: string): void;
}

interface PhaseRow {
  readonly element: HTMLElement;
  readonly grip: HTMLElement;
  readonly movable: boolean;
  move(to: number): void;
}

function phaseRow(
  api: DreyPluginApi,
  buf: ColumnsBuffer,
  id: string,
  index: number,
  length: number,
  handlers: RowHandlers,
  armed: boolean,
): PhaseRow {
  const base = buf.base.pipeline.find((p) => p.id === id) ?? null;
  const added = buf.added.get(id) ?? null;
  const title = added ?? base?.title ?? id;
  const raw = buf.patch[id];
  const baseHandover = base !== null ? parseHandover(base.handover) : null;
  const worker = raw !== undefined && raw.worker !== undefined ? (raw.worker ?? '') : (base?.worker ?? '');
  const auto = rowAuto(buf, id);
  const movable = index > 0 && index < length - 1;
  const row = el('div', `tset-row${auto ? '' : ' tset-row-manual'}`);
  row.setAttribute('role', 'row');
  row.tabIndex = 0;
  row.dataset.id = id;
  row.setAttribute(
    'aria-label',
    `${title}, position ${folderNumber(index)}${movable ? '. Alt+Up or Alt+Down moves it' : ''}`,
  );

  // Order cell: a grip, or a pin for the capture target and the terminal.
  const grip = el('span', movable ? 'tset-grip' : 'tset-pin');
  const gripLabel = movable
    ? `Drag ${title} to reorder`
    : index === 0
      ? 'Capture target — always first'
      : 'Terminal — always last';
  grip.title = gripLabel;
  grip.setAttribute('aria-label', gripLabel);
  grip.append(api.ui.icon(movable ? 'grip-vertical' : 'pin', 14));

  const number = el('span', 'tset-num', folderNumber(index));
  const name = el('span', 'tset-name');
  const dir = base !== null ? currentDir(buf.base.folders, id, index) : 'new folder on save';
  const meta = el('span', 'tset-name-meta');
  meta.append(
    el(
      'span',
      `tset-chip ${auto ? 'tset-chip-auto' : 'tset-chip-manual'}`,
      added !== null ? 'New' : auto ? 'Runs itself' : 'Checkpoint',
    ),
    el('span', 'tset-name-dir', dir),
  );
  name.append(el('span', 'tset-name-title', title), meta);
  name.title = `${title} — tickets/${dir}`;

  const workerCell = el('select', 'tset-worker');
  workerCell.setAttribute('aria-label', `Worker for ${title}`);
  for (const [value, label] of WORKER_CHOICES) {
    workerCell.append(Object.assign(el('option', undefined, label), { value, selected: value === worker }));
  }
  if (worker === '' && auto && baseHandover !== null) {
    // A hand-written `agent …@worker` handover without a worker: key — shown, not guessed away.
    workerCell.append(
      Object.assign(el('option', undefined, `Handover pin (${baseHandover.worker ?? 'default'})`), {
        value: '@pin',
        selected: true,
      }),
    );
  }
  workerCell.addEventListener('change', () => {
    if (workerCell.value !== '@pin') {
      handlers.onEdit({ worker: workerCell.value });
      handlers.onWorkerChange();
    }
  });

  const cells: HTMLElement[] = [grip, number, name, cell(workerCell)];
  if (auto) {
    const model =
      raw !== undefined && raw.model !== undefined ? (raw.model ?? '') : (base?.model ?? '');
    const workerOf = (): string =>
      (raw !== undefined && raw.worker !== undefined ? (raw.worker ?? '') : (base?.worker ?? '')) ||
      baseHandover?.worker ||
      buf.base.defaultWorker;
    const modelCtl = modelPicker(api, title, model, workerOf, (value) => handlers.onEdit({ model: value }));

    const pool = el('input');
    pool.type = 'number';
    pool.min = '1';
    pool.max = '16';
    pool.step = '1';
    const workers = raw !== undefined && raw.workers !== undefined ? (raw.workers ?? 1) : (base?.workers ?? 1);
    pool.value = String(workers);
    pool.setAttribute('aria-label', `Pool size for ${title}`);
    pool.addEventListener('change', () => {
      const parsed = Number(pool.value);
      handlers.onEdit({ workers: Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : null });
    });

    const promptCell = el('select', 'mono-input');
    promptCell.setAttribute('aria-label', `Prompt for ${title}`);
    const explicit = raw !== undefined && raw.prompt !== undefined ? (raw.prompt ?? '') : (base?.prompt ?? '');
    const handoverRef =
      base !== null
        ? baseHandover!.promptRef
        : // A staffed new column's future handover names its default ref.
          worker !== '' && explicit === ''
          ? `${id}-default`
          : null;
    const options = promptOptions(explicit === '' ? null : explicit, handoverRef, buf.base.promptRefs);
    for (const option of options) {
      promptCell.append(
        Object.assign(el('option', undefined, option.label), {
          value: option.value,
          selected: option.value === explicit,
        }),
      );
    }
    promptCell.title = explicit === '' ? (handoverRef ?? '(none)') : explicit;
    promptCell.addEventListener('change', () => handlers.onEdit({ prompt: promptCell.value }));
    cells.push(cell(modelCtl.root), cell(pool), cell(promptCell));
  } else {
    for (const label of ['No model', 'No pool', 'No prompt']) {
      const dash = el('span', 'tset-dash', '—');
      dash.setAttribute('aria-label', label);
      cells.push(dash);
    }
  }

  // The row's actions: ↑/↓ and the armed − (never on the pinned ends).
  const actions = el('span', 'tset-row-actions');
  const up = iconButton(api, 'chevron-up', `Move ${title} up`);
  const down = iconButton(api, 'chevron-down', `Move ${title} down`);
  const remove = iconButton(api, 'x', `Remove ${title}`);
  remove.classList.add('tset-remove');
  up.disabled = !movable || index <= 1;
  down.disabled = !movable || index >= length - 2;
  remove.disabled = false;
  if (armed) {
    remove.classList.add('tset-armed');
    remove.title = `Confirm removing ${title}`;
    remove.setAttribute('aria-label', `Confirm removing ${title}`);
    remove.replaceChildren(api.ui.icon('triangle-alert', 14));
  }
  up.addEventListener('click', () => handlers.onMove(index - 1));
  down.addEventListener('click', () => handlers.onMove(index + 1));
  remove.addEventListener('click', () => handlers.onRemove(remove, title));
  actions.append(up, down, remove);
  cells.push(actions);

  for (const c of cells) {
    c.setAttribute('role', 'cell');
  }
  row.append(...cells);
  return { element: row, grip, movable, move: (to) => handlers.onMove(to) };
}

function cell(control: HTMLElement): HTMLElement {
  const wrap = el('span', 'tset-cell');
  wrap.append(control);
  return wrap;
}

/** The folder a phase lives in today: a pending rename's source, else its derived name. */
function currentDir(folders: ColumnsState['folders'], id: string, index: number): string {
  const pending = folders.moves.find((m) => stripPhasePrefix(m.from) === id);
  return pending?.from ?? `${folderNumber(index)}-${id}`;
}

function capitalize(text: string): string {
  return text === '' ? text : text[0]!.toUpperCase() + text.slice(1);
}
