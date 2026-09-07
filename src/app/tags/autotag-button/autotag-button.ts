import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { EntryDraftService } from '../../services/entry-draft.service';
import { LlmTaskService } from '../../services/llm-task.service';
import { Icon } from '../../icons/icon';

/**
 * The drawer's "Autotag" button: sends the current entry text to the local
 * model and adds the suggested tags as chips. Deliberately isolated -- it
 * only reads `EntryDraftService.text()` and calls `addChip`, so removing
 * the feature is deleting this component and one line of drawer markup.
 */
@Component({
  selector: 'app-autotag-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <button
      type="button"
      class="autotag"
      [disabled]="!canRun()"
      [title]="error() ?? 'Suggest tags for this entry'"
      (click)="run()"
    >
      <app-icon name="sparkles" [size]="12" />
      {{ busy() ? 'Tagging…' : 'Autotag' }}
    </button>
  `,
  styles: `
    .autotag {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border: 1px solid var(--border-strong);
      border-radius: 999px;
      background: transparent;
      color: var(--text-4);
      font-size: 11px;
      padding: 2px 9px;
      cursor: pointer;
    }
    .autotag:hover:not(:disabled) {
      color: var(--text-primary);
    }
    .autotag:disabled {
      opacity: 0.45;
      cursor: default;
    }
  `,
})
export class AutotagButton {
  private readonly draft = inject(EntryDraftService);
  private readonly llmTasks = inject(LlmTaskService);

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly canRun = computed<boolean>(
    () => !this.busy() && this.draft.text().trim() !== '',
  );

  private get api() {
    return typeof window !== 'undefined' ? window.dreyApi : undefined;
  }

  protected async run(): Promise<void> {
    const text = this.draft.text().trim();
    if (!this.api?.suggestTags || text === '' || this.busy()) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      const { value } = await this.llmTasks.run('Suggesting tags', (taskId) =>
        this.api!.suggestTags(text, taskId),
      );
      for (const tag of value) {
        this.draft.addChip(tag);
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
