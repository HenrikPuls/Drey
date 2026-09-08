import { Injectable, computed, inject, signal } from '@angular/core';
import { TagSearchHit } from '../../../shared/ipc-api';
import { LlmTaskService } from '../services/llm-task.service';

/**
 * Query state, results and the on-demand LLM digest for the sidebar
 * tag-search panel. The component only renders and forwards events
 * (CLAUDE.md: no business logic in components). One or more tags (AND) plus
 * optional free text (AND); the matcher runs in the main process
 * (`tags:search`), the digest through `tags:summarise-results`.
 */
@Injectable({ providedIn: 'root' })
export class TagSearchService {
  private readonly llmTasks = inject(LlmTaskService);

  readonly queryTags = signal<string[]>([]);
  readonly queryText = signal('');

  /**
   * Whether the sidebar "Search" section is expanded. Lifted out of the
   * component so a `#tag` pill click in the editor and the `Mod+Shift+F`
   * keybinding can open it. `focusRequest` bumps to ask the panel to move
   * focus into its tag input.
   */
  readonly panelOpen = signal(false);
  readonly focusRequest = signal(0);

  readonly hits = signal<TagSearchHit[]>([]);
  readonly searching = signal(false);
  /** True once a non-empty query has been run -- drives the "no results" line. */
  readonly ran = signal(false);

  readonly summary = signal<string | null>(null);
  readonly summarising = signal(false);
  readonly summaryError = signal<string | null>(null);
  private summaryTaskId: string | null = null;

  readonly hasQuery = computed<boolean>(
    () => this.queryTags().length > 0 || this.queryText().trim() !== '',
  );

  private get api() {
    return typeof window !== 'undefined' ? window.dreyApi : undefined;
  }

  addTag(raw: string): void {
    const tag = raw.trim().replace(/^#/, '').toLowerCase();
    if (tag === '' || this.queryTags().includes(tag)) {
      return;
    }
    this.queryTags.update((list) => [...list, tag]);
    this.invalidateSummary();
  }

  removeTag(tag: string): void {
    this.queryTags.update((list) => list.filter((t) => t !== tag));
    this.invalidateSummary();
  }

  /** Expand the panel and ask it to focus the tag input (keybinding entry point). */
  openPanel(): void {
    this.panelOpen.set(true);
    this.focusRequest.update((n) => n + 1);
  }

  togglePanel(): void {
    this.panelOpen.update((v) => !v);
    if (this.panelOpen()) {
      this.focusRequest.update((n) => n + 1);
    }
  }

  /**
   * Replace the whole query with a single tag, expand the panel and run --
   * the editor's `#tag` pills call this on a modifier-click.
   */
  searchTag(raw: string): void {
    this.clear();
    this.addTag(raw);
    this.panelOpen.set(true);
    void this.run();
  }

  setText(value: string): void {
    this.queryText.set(value);
    this.invalidateSummary();
  }

  clear(): void {
    this.queryTags.set([]);
    this.queryText.set('');
    this.hits.set([]);
    this.ran.set(false);
    this.invalidateSummary();
  }

  async run(): Promise<void> {
    this.invalidateSummary();
    if (!this.api || !this.hasQuery()) {
      this.hits.set([]);
      this.ran.set(false);
      return;
    }
    this.searching.set(true);
    try {
      this.hits.set(
        await this.api.searchTags({ tags: this.queryTags(), text: this.queryText().trim() }),
      );
      this.ran.set(true);
    } catch {
      this.hits.set([]);
    } finally {
      this.searching.set(false);
    }
  }

  async summarise(): Promise<void> {
    if (!this.api || !this.hasQuery() || this.summarising()) {
      return;
    }
    this.summary.set(null);
    this.summaryError.set(null);
    this.summarising.set(true);
    try {
      const { value } = await this.llmTasks.run('Summarising results', (taskId) => {
        this.summaryTaskId = taskId;
        return this.api!.summariseSearchResults(
          { tags: this.queryTags(), text: this.queryText().trim() },
          taskId,
        );
      });
      this.summary.set(value);
    } catch (err) {
      this.summaryError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.summarising.set(false);
      this.summaryTaskId = null;
    }
  }

  cancelSummary(): void {
    void this.llmTasks.cancel(this.summaryTaskId ?? undefined);
  }

  private invalidateSummary(): void {
    this.summary.set(null);
    this.summaryError.set(null);
  }
}
