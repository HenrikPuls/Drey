import type { DreyPluginApi, SdkTaskRecord } from '../../../shared/plugin-api/renderer';
import { ipcErrorMessage } from '../../../shared/ipc-error';
import { el, icon } from './dom.js';

/**
 * The interactive task block replacing the `tasks_list` chip pair
 * (SDK 1.11): rows with checkbox / text / priority / due badge, a click
 * on the row opens the note at the line, the checkbox completes the
 * task through the task provider (the tasks plugin owns the line
 * grammar). The fence rows are a snapshot — the LIVE done/due state
 * hydrates from the provider right after mount. Rows arrive in the
 * provider's deterministic view order (importance by default); the
 * block never re-sorts.
 */
export function taskListNode(
  api: DreyPluginApi,
  initial: readonly SdkTaskRecord[],
  truncated: number,
  filterParts: readonly string[] = [],
): HTMLElement {
  const box = el('div', 'task-block');
  let records = [...initial];

  const head = el('div', 'task-block-head');
  head.appendChild(icon('check', 11));
  head.appendChild(
    el('span', undefined, `Tasks · ${records.length}${truncated > 0 ? ` (+${truncated} more)` : ''}`),
  );
  if (filterParts.length > 0) {
    head.appendChild(el('span', 'task-block-filter', filterParts.join(' · ')));
  }
  box.appendChild(head);

  const rowsBox = el('div', 'task-block-rows');
  box.appendChild(rowsBox);
  const errorLine = el('div', 'task-block-error');
  errorLine.hidden = true;
  box.appendChild(errorLine);

  const dueBadge = (task: SdkTaskRecord): HTMLElement | null => {
    if (task.due === null) {
      return null;
    }
    const today = new Date();
    const pad = (v: number): string => String(v).padStart(2, '0');
    const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const overdue = !task.done && task.due < todayStr;
    const soon = !task.done && task.due === todayStr;
    return el('span', `task-due${overdue ? ' overdue' : soon ? ' today' : ''}`, task.due);
  };

  const renderRows = (): void => {
    rowsBox.replaceChildren();
    for (const [index, task] of records.entries()) {
      const row = el('div', 'task-row' + (task.done ? ' done' : ''));

      const check = el('button', 'task-check' + (task.done ? ' checked' : '')) as HTMLButtonElement;
      check.type = 'button';
      check.appendChild(icon('check', 10));
      check.title = task.done ? 'Re-open this task' : 'Complete this task';
      check.setAttribute('aria-label', check.title);
      check.addEventListener('click', (event) => {
        event.stopPropagation();
        void (async () => {
          check.disabled = true;
          try {
            const updated = (await api.backend.invoke('tasks:setDone', {
              task,
              done: !task.done,
            })) as SdkTaskRecord;
            records[index] = updated;
            renderRows();
          } catch (err) {
            errorLine.textContent = `Could not update the task: ${ipcErrorMessage(err)}`;
            errorLine.hidden = false;
            check.disabled = false;
          }
        })();
      });
      row.appendChild(check);

      const open = el('button', 'task-open') as HTMLButtonElement;
      open.type = 'button';
      open.appendChild(el('span', 'task-text', task.text));
      if (task.priority === 'highest') {
        open.appendChild(el('span', 'task-prio', '🔺'));
      } else if (task.priority === 'high') {
        open.appendChild(el('span', 'task-prio', '⏫'));
      } else if (task.priority === 'low') {
        open.appendChild(el('span', 'task-prio', '🔽'));
      }
      // A completed task shows WHEN it was completed (57d); its due
      // date no longer matters.
      if (task.done && typeof task.completed === 'string') {
        const completed = el('span', 'task-due', `✅ ${task.completed}`);
        completed.title = `Completed ${task.completed}`;
        open.appendChild(completed);
      } else {
        const due = dueBadge(task);
        if (due !== null) {
          open.appendChild(due);
        }
      }
      open.title = `${task.path}:${task.line}${task.heading !== null ? ` — ${task.heading}` : ''}`;
      open.addEventListener('click', () => {
        void api.documents.open(task.path, task.line, { vaultId: task.vaultId });
      });
      row.appendChild(open);
      rowsBox.appendChild(row);
    }
    if (records.length === 0) {
      rowsBox.appendChild(el('div', 'task-block-empty', 'No tasks in this result.'));
    }
  };
  renderRows();

  // The fence is a snapshot; the live index is the truth (same
  // fresh-hydration rule as the vault context). Same length expected —
  // anything else keeps the persisted rows visible.
  void (async () => {
    try {
      const current = (await api.backend.invoke('tasks:hydrate', {
        records,
      })) as SdkTaskRecord[];
      if (Array.isArray(current) && current.length === records.length) {
        records = current;
        renderRows();
      }
    } catch {
      // The persisted rows stand.
    }
  })();

  return box;
}
