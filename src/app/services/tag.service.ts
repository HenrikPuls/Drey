import { Injectable, signal } from '@angular/core';
import { TagEntry } from '../../../shared/ipc-api';

/**
 * The vault's tag vocabulary, held as a signal for the editor's `#tag`
 * autocomplete. Same shape as `VaultService`: call the IPC bridge, keep
 * the result, no logic. The main-process `TagIndex` is the source of
 * truth; this refreshes on construction and whenever the editor reports a
 * save that changed the tag set.
 */
@Injectable({ providedIn: 'root' })
export class TagService {
  readonly tags = signal<TagEntry[]>([]);

  constructor() {
    void this.refresh();
  }

  private get api() {
    return typeof window !== 'undefined' ? window.dreyApi : undefined;
  }

  async refresh(): Promise<void> {
    if (!this.api) {
      return;
    }
    try {
      this.tags.set(await this.api.listTags());
    } catch {
      this.tags.set([]);
    }
  }
}
