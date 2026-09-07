import { Injectable, computed, inject, signal } from '@angular/core';
import { TagSearchHit } from '../../../shared/ipc-api';

/**
 * Query state and results for the sidebar tag-search panel. The component
 * only renders and forwards events (CLAUDE.md: no business logic in
 * components). One or more tags (AND) plus optional free text (AND); the
 * matcher runs in the main process (`tags:search`).
 */
@Injectable({ providedIn: 'root' })
export class TagSearchService {
  readonly queryTags = signal<string[]>([]);
  readonly queryText = signal('');

  readonly hits = signal<TagSearchHit[]>([]);
  readonly searching = signal(false);
  /** True once a non-empty query has been run -- drives the "no results" line. */
  readonly ran = signal(false);

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
  }

  removeTag(tag: string): void {
    this.queryTags.update((list) => list.filter((t) => t !== tag));
  }

  setText(value: string): void {
    this.queryText.set(value);
  }

  clear(): void {
    this.queryTags.set([]);
    this.queryText.set('');
    this.hits.set([]);
    this.ran.set(false);
  }

  async run(): Promise<void> {
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
}
