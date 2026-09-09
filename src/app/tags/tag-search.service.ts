import { Injectable, computed, inject, signal } from '@angular/core';
import { TagSearchHit, TagSearchQuery } from '../../../shared/ipc-api';
import { runTagSearch, sectionRecordsFor } from '../../../shared/tags';
import { EditorService } from '../services/editor.service';
import { LlmTaskService } from '../llm';

/** Files under here are kept out of the tag index (mirrors `TagIndex`). */
const TEMPLATES_PREFIX = 'templates/';

/**
 * Query state, results and the on-demand LLM digest for the sidebar
 * tag-search panel. The component only renders and forwards events
 * (CLAUDE.md: no business logic in components). One or more tags (AND) plus
 * optional free text (AND); the matcher runs in the main process
 * (`tags:search`) over the files on disk, then this service folds in hits
 * from open tabs' unsaved buffers; the digest goes through
 * `tags:summarise-results`.
 */
@Injectable({ providedIn: 'root' })
export class TagSearchService {
  private readonly llmTasks = inject(LlmTaskService);
  private readonly editor = inject(EditorService);

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
      const query: TagSearchQuery = { tags: this.queryTags(), text: this.queryText().trim() };
      const diskHits = await this.api.searchTags(query);
      this.hits.set(this.withOpenBufferHits(diskHits, query));
      this.ran.set(true);
    } catch {
      this.hits.set([]);
    } finally {
      this.searching.set(false);
    }
  }

  /**
   * Fold hits from open tabs' live buffers into the on-disk results. A tab
   * with unsaved edits (or a never-saved scratch tab) replaces its own
   * on-disk hits with what its current text matches -- tagged `unsaved` so
   * the panel can mark it. A saved, unmodified tab contributes nothing new.
   * `sectionRecordsFor` + `runTagSearch` are the exact routines the main
   * process runs, so an unsaved edit is searched as it will be once saved.
   */
  private withOpenBufferHits(diskHits: TagSearchHit[], query: TagSearchQuery): TagSearchHit[] {
    const dirty = this.editor
      .openDocs()
      .filter(
        (d) =>
          d.kind === 'text' &&
          d.bufferContent !== d.savedContent &&
          !d.path.startsWith(TEMPLATES_PREFIX) &&
          // The tag-search export tab would otherwise match its own dump.
          !(d.name === 'search-results.md' && !d.existsOnDisk),
      );
    if (dirty.length === 0) {
      return diskHits;
    }
    const dirtyPaths = new Set(dirty.map((d) => d.path));
    const merged = diskHits.filter((h) => !dirtyPaths.has(h.path));
    for (const doc of dirty) {
      for (const hit of runTagSearch(sectionRecordsFor(doc.path, doc.bufferContent), query)) {
        merged.push({ ...hit, unsaved: true });
      }
    }
    merged.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    return merged;
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
