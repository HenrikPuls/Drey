import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { EntryDraftService } from './entry-draft.service';
import { Icon } from '../icons/icon';

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
      // The renderer mints the taskId (the cancel registry is base); the
      // button shows no running label or Cancel, so the id is only plumbed
      // through for symmetry with the other generation surfaces.
      const taskId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `tag-${Date.now().toString(36)}`;
      const tags = await this.api.suggestTags(text, taskId);
      for (const tag of tags) {
        this.draft.addChip(tag);
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
