import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TaskRecord } from '../../../../shared/tasks';
import { TaskService } from '../task.service';

/** A file's tasks, for the grouped "whole vault" list. */
interface TaskGroup {
  path: string;
  name: string;
  tasks: TaskRecord[];
}

/**
 * The "Tasks" dock panel: every checkbox / `#task` line in the open
 * document or the whole vault. A scope switch (document ⇄ vault), a "hide
 * done" toggle and a kind filter (checkboxes / `#task`) drive
 * `TaskService`; a row's checkbox writes the done-state straight back to
 * the source file, clicking a row opens it at that line.
 */
@Component({
  selector: 'app-tasks-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './tasks-panel.html',
  styleUrl: './tasks-panel.css',
})
export class TasksPanel {
  protected readonly tasks = inject(TaskService);

  /** Flat in document scope; grouped by file in vault scope. */
  protected readonly groups = computed<TaskGroup[]>(() => {
    const visible = this.tasks.visible();
    if (this.tasks.scope() === 'document') {
      return visible.length ? [{ path: '', name: '', tasks: visible }] : [];
    }
    const byPath = new Map<string, TaskRecord[]>();
    for (const task of visible) {
      const list = byPath.get(task.path);
      if (list) {
        list.push(task);
      } else {
        byPath.set(task.path, [task]);
      }
    }
    return [...byPath.entries()].map(([path, tasks]) => ({
      path,
      name: path.split('/').pop() ?? path,
      tasks,
    }));
  });

  protected readonly empty = computed(() => this.tasks.visible().length === 0);
}
