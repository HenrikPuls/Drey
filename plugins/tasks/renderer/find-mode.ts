// i18n: catalog
/**
 * The Tasks mode of the Find panel (req-161, board 9c): the list the tasks
 * plugin mounts into the panel through the find-mode registry (SDK 1.53).
 * The plugin keeps its index, its task-line writes and its pickers; this
 * file draws the rows, the groups and the menu rows from the data the
 * entry point hands in.
 */
import type {
  DreyPluginApi,
  FindMenuEntry,
  FindModeContrib,
  FindModeHandle,
  FindQuery,
} from '../../../shared/plugin-api/renderer';
import type { TaskRecord } from '../shared/tasks.js';
import { dueState, todayIso } from '../shared/tasks.js';
import { ALL_KINDS, type TaskSort } from './filter.js';
import { openDuePicker, openPriorityPicker } from './task-meta.js';

/** What the mode needs from the plugin entry: data in, writes out. */
export interface TasksModeHost {
  /** The tasks the query selects, filtered and in the panel's order. */
  visibleTasks(query: FindQuery): TaskRecord[];
  prefs(): { hideDone: boolean; kinds: readonly (typeof ALL_KINDS)[number][]; sort: TaskSort };
  setHideDone(hide: boolean): void;
  toggleKind(kind: (typeof ALL_KINDS)[number]): void;
  setSort(sort: TaskSort): void;
  vaultName(vaultId: string): string;
  activeVaultId(): string | null;
  toggleTask(task: TaskRecord): Promise<void>;
  changeTaskDue(task: TaskRecord, due: string | null): Promise<void>;
  changeTaskPriority(task: TaskRecord, priority: 'highest' | 'high' | 'low' | null): Promise<void>;
  /** Fires when tasks or the mode's own choices change. */
  onChange(listener: () => void): () => void;
}

export type DueGroupId = 'overdue' | 'today' | 'later' | 'none';

export interface DueGroup {
  readonly id: DueGroupId;
  readonly tasks: TaskRecord[];
}

/** The due-date order's groups: Overdue · Today · Later · No date (empty ones left out). */
export function groupByDue(tasks: readonly TaskRecord[], today: string = todayIso()): DueGroup[] {
  const groups: Record<DueGroupId, TaskRecord[]> = { overdue: [], today: [], later: [], none: [] };
  for (const task of tasks) {
    if (task.due === null) {
      groups.none.push(task);
    } else {
      const state = dueState(task.due, today);
      groups[state === 'future' ? 'later' : state].push(task);
    }
  }
  return (['overdue', 'today', 'later', 'none'] as const)
    .filter((id) => groups[id].length > 0)
    .map((id) => ({ id, tasks: groups[id] }));
}

/** The open-count status line for a query's scope. */
export function statusFor(
  api: DreyPluginApi,
  openCount: number,
  scope: FindQuery['scope'],
): string | null {
  if (openCount === 0) {
    return null;
  }
  const t = api.i18n.t;
  return scope === 'file'
    ? t('find.status.open_note', { count: openCount })
    : scope === 'all'
      ? t('find.status.open_all', { count: openCount })
      : t('find.status.open', { count: openCount });
}

const sortLabelKey = {
  file: 'find.sort.file',
  due: 'find.sort.due',
  priority: 'find.sort.priority',
} as const;

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

export function createTasksFindMode(api: DreyPluginApi, host: TasksModeHost): FindModeContrib {
  const t = api.i18n.t;
  const openCount = (query: FindQuery): number =>
    host.visibleTasks(query).filter((task) => !task.done).length;

  /** `Nov 4`; the year joins when it is not the current one. */
  const dueText = (due: string): string => {
    const [y, m, d] = due.split('-').map(Number) as [number, number, number];
    const when = new Date(y, m - 1, d);
    return new Intl.DateTimeFormat(api.i18n.locale, {
      month: 'short',
      day: 'numeric',
      ...(y === new Date().getFullYear() ? {} : { year: 'numeric' }),
    }).format(when);
  };

  const menu = (): readonly FindMenuEntry[] => {
    const prefs = host.prefs();
    const order = (sort: TaskSort): FindMenuEntry => ({
      kind: 'check',
      label: t(sortLabelKey[sort]),
      checked: prefs.sort === sort,
      run: () => host.setSort(sort),
    });
    return [
      {
        kind: 'check',
        label: t('find.menu.show_done'),
        checked: !prefs.hideDone,
        run: () => host.setHideDone(!prefs.hideDone),
      },
      {
        kind: 'check',
        label: t('find.menu.checkbox_tasks'),
        checked: prefs.kinds.includes('checkbox'),
        run: () => host.toggleKind('checkbox'),
      },
      {
        kind: 'check',
        label: t('find.menu.task_lines'),
        checked: prefs.kinds.includes('tag'),
        run: () => host.toggleKind('tag'),
      },
      { kind: 'separator' },
      { kind: 'label', label: t('find.menu.order') },
      order('file'),
      order('due'),
      order('priority'),
    ];
  };

  const mount = (listHost: HTMLElement, initial: FindQuery): FindModeHandle => {
    let query = initial;
    /** Due groups the owner flipped from their default (Later and No date start folded). */
    const flipped = new Set<DueGroupId>();
    const folded = (id: DueGroupId): boolean =>
      (id === 'later' || id === 'none') !== flipped.has(id);
    const content = el('div', 'find-tasks');
    listHost.appendChild(content);

    const taskRow = (task: TaskRecord): HTMLElement => {
      const wrap = el('div', 'find-task');
      if (task.done) {
        wrap.classList.add('done');
      }
      const box = el('button', 'find-task-box') as HTMLButtonElement;
      box.type = 'button';
      box.setAttribute('role', 'checkbox');
      box.setAttribute('aria-checked', String(task.done));
      box.setAttribute('aria-label', task.done ? t('find.task.mark_not_done') : t('find.task.mark_done'));
      if (task.done) {
        box.appendChild(api.ui.icon('check', 12));
      }
      box.addEventListener('click', () => void host.toggleTask(task));

      // The meta row (with its badge BUTTONS) sits beside the title button,
      // not inside it: a button inside a button is invalid HTML.
      const rows = el('div', 'find-task-body');
      const title = el('button', 'find-task-title', task.text || t('find.task.untitled')) as HTMLButtonElement;
      title.type = 'button';
      title.addEventListener(
        'click',
        () => void api.documents.open(task.path, task.line, { vaultId: task.vaultId }),
      );
      rows.appendChild(title);

      const meta = el('span', 'find-task-meta');
      const part = (node: HTMLElement): void => {
        if (meta.childElementCount > 0) {
          meta.appendChild(el('span', 'find-task-dot', '·'));
        }
        meta.appendChild(node);
      };
      if (task.kind === 'tag') {
        part(el('span', 'find-task-kind', t('find.task.kind_tag')));
      }
      if (task.due !== null) {
        const state = dueState(task.due, todayIso());
        const due = el('button', `find-badge ${state}`) as HTMLButtonElement;
        due.type = 'button';
        due.appendChild(api.ui.icon('calendar', 14));
        due.appendChild(
          el('span', undefined, state === 'today' ? t('find.due.today') : dueText(task.due)),
        );
        const label = t('find.task.change_due', { due: task.due });
        due.title = label;
        due.setAttribute('aria-label', label);
        due.addEventListener('click', () => {
          const rect = due.getBoundingClientRect();
          openDuePicker({ left: rect.left, top: rect.bottom }, task.due, (value) =>
            void host.changeTaskDue(task, value),
          );
        });
        part(due);
      }
      if (task.priority !== null) {
        const prio = el('button', `find-badge prio-${task.priority}`) as HTMLButtonElement;
        prio.type = 'button';
        prio.appendChild(api.ui.icon(task.priority === 'low' ? 'arrow-down' : 'arrow-up', 14));
        prio.appendChild(el('span', undefined, api.i18n.lookup(`find.priority.${task.priority}`)));
        const label = t('find.task.change_priority', {
          priority: api.i18n.lookup(`find.priority.${task.priority}`),
        });
        prio.title = label;
        prio.setAttribute('aria-label', label);
        prio.addEventListener('click', () => {
          const rect = prio.getBoundingClientRect();
          openPriorityPicker({ left: rect.left, top: rect.bottom }, (value) =>
            void host.changeTaskPriority(task, value),
          );
        });
        part(prio);
      }
      if (task.heading !== null) {
        part(el('span', 'find-task-heading', task.heading));
      }
      rows.appendChild(meta);
      wrap.append(box, rows);
      return wrap;
    };

    /** A 28 px group head over `rows`; the chevron folds it. */
    const group = (
      head: HTMLElement[],
      count: number,
      rows: HTMLElement[],
      open: boolean,
      onToggle: (open: boolean) => void,
      title?: string,
    ): HTMLElement => {
      const wrap = el('div', 'find-group');
      const button = el('button', 'find-group-head') as HTMLButtonElement;
      button.type = 'button';
      button.setAttribute('aria-expanded', String(open));
      const chevron = el('span', 'find-chevron');
      chevron.appendChild(api.ui.icon('chevron-down', 14));
      button.append(chevron, ...head, el('span', 'find-group-count', String(count)));
      if (title !== undefined) {
        button.title = title;
      }
      const body = el('div', 'find-group-rows');
      body.hidden = !open;
      body.append(...rows);
      button.addEventListener('click', () => {
        const next = body.hidden === true;
        body.hidden = !next;
        button.setAttribute('aria-expanded', String(next));
        onToggle(next);
      });
      wrap.append(button, body);
      return wrap;
    };

    const filePath = new Set<string>();
    const render = (): void => {
      content.textContent = '';
      const tasks = host.visibleTasks(query);
      if (tasks.length === 0) {
        content.appendChild(el('p', 'find-empty', t('find.empty.tasks')));
        return;
      }
      const sort = host.prefs().sort;
      if (sort === 'due') {
        for (const due of groupByDue(tasks)) {
          content.appendChild(
            group(
              [el('span', 'find-group-name', api.i18n.lookup(`find.group.${due.id}`))],
              due.tasks.length,
              due.tasks.map(taskRow),
              !folded(due.id),
              () => {
                if (flipped.has(due.id)) {
                  flipped.delete(due.id);
                } else {
                  flipped.add(due.id);
                }
              },
            ),
          );
        }
        return;
      }
      if (query.scope === 'file' || sort === 'priority') {
        content.append(...tasks.map(taskRow));
        return;
      }
      // File order: one group per file; the folder and, in another vault, its name beside it.
      interface FileGroup {
        key: string;
        head: HTMLElement[];
        path: string;
        rows: HTMLElement[];
      }
      let current: FileGroup | null = null;
      const groups: FileGroup[] = [];
      for (const task of tasks) {
        const key = `${task.vaultId} ${task.path}`;
        if (current === null || current.key !== key) {
          const cut = task.path.lastIndexOf('/');
          const head = [el('span', 'find-group-name', cut === -1 ? task.path : task.path.slice(cut + 1))];
          if (cut !== -1) {
            head.push(el('span', 'find-group-folder', task.path.slice(0, cut)));
          }
          if (task.vaultId !== host.activeVaultId()) {
            head.push(el('span', 'find-group-vault', host.vaultName(task.vaultId)));
          }
          current = { key, head, path: task.path, rows: [] };
          groups.push(current);
        }
        current.rows.push(taskRow(task));
      }
      for (const g of groups) {
        content.appendChild(
          group(
            g.head,
            g.rows.length,
            g.rows,
            !filePath.has(g.key),
            (open) => {
              if (open) {
                filePath.delete(g.key);
              } else {
                filePath.add(g.key);
              }
            },
            g.path,
          ),
        );
      }
    };
    render();
    return {
      update: (next) => {
        query = next;
        render();
      },
      onChange: (listener) => host.onChange(listener),
      dispose: () => content.remove(),
    };
  };

  return {
    id: 'tasks',
    label: t('find.mode.tasks'),
    order: 20,
    status: (query) => statusFor(api, openCount(query), query.scope),
    menu,
    mount,
  };
}
