import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TaskRecord } from '../../../../shared/tasks';
import { PanelHeaderActions } from '../../dock/panel-header-actions';
import { TagService } from '../../services/tag.service';
import { TaskService } from '../task.service';

/** A file's tasks, for the grouped "whole vault" list. */
interface TaskGroup {
  path: string;
  name: string;
  tasks: TaskRecord[];
}

/**
 * The "Tasks" dock panel: every checkbox / `#task` line in the open
 * document or the whole vault. The scope switch (document ⇄ vault), the
 * "hide done" toggle and the kind filter live in the panel header
 * (`PanelHeaderActions`, req-7); the body carries a free-text + multi-tag
 * filter (req-8, tag autocomplete over the vault vocabulary) and the list.
 * A row's checkbox writes the done-state straight back to the source file,
 * clicking a row opens it at that line.
 */
@Component({
  selector: 'app-tasks-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PanelHeaderActions],
  templateUrl: './tasks-panel.html',
  styleUrl: './tasks-panel.css',
})
export class TasksPanel {
  protected readonly tasks = inject(TaskService);
  /** Vault tag vocabulary for the `<datalist>` autocomplete. */
  protected readonly vocab = inject(TagService);

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
    // The full vault-relative path (not just the basename): it disambiguates
    // same-named notes in different folders and matches the Search panel's
    // `.hit-path`. The header wraps rather than truncating (see the CSS).
    return [...byPath.entries()].map(([path, tasks]) => ({
      path,
      name: path,
      tasks,
    }));
  });

  protected readonly empty = computed(() => this.tasks.visible().length === 0);

  /** Enter / comma commits the typed tag; Backspace on an empty field pops the last chip. */
  protected onTagKeydown(event: KeyboardEvent): void {
    const input = event.target as HTMLInputElement;
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      if (input.value.trim() !== '') {
        this.tasks.addTag(input.value);
        input.value = '';
      }
      return;
    }
    if (event.key === 'Backspace' && input.value === '') {
      const list = this.tasks.queryTags();
      if (list.length > 0) {
        this.tasks.removeTag(list[list.length - 1]);
      }
    }
  }

  protected onTagBlur(event: FocusEvent): void {
    const input = event.target as HTMLInputElement;
    if (input.value.trim() !== '') {
      this.tasks.addTag(input.value);
      input.value = '';
    }
  }
}
