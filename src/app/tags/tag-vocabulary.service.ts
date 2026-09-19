import { Injectable, effect, inject, signal } from '@angular/core';
import type { TagEntry, TagPrefixStyle } from '../../../shared/plugin-api/search-types';
import { resolveTagStyle, type TagStyleInfo } from '../../../shared/tag-style';
import { PluginHostService } from '../plugin-host';
import type { TagFieldVocabulary } from './tag-field';

/**
 * The base's window onto the tag vocabulary (milestone 33): entries and
 * prefix styles come from the section-search provider — the Tags plugin —
 * over `search:vocabulary`, refreshed whenever `search:changed` ticks.
 *
 * Base owns the *rendering* of tags (pills, chips, completion); the plugin
 * stays the data owner (ADR-0044). With no provider registered (tags
 * plugin disabled or failed) everything degrades: empty completion, no
 * configured prefixes — tags still render with auto palette colors.
 */
@Injectable({ providedIn: 'root' })
export class TagVocabularyService implements TagFieldVocabulary {
  private readonly pluginHost = inject(PluginHostService);

  /** The vault-wide tag vocabulary with section counts. */
  readonly entries = signal<readonly TagEntry[]>([]);
  /** Configured prefix styles from the provider (empty when unimplemented). */
  readonly prefixes = signal<readonly TagPrefixStyle[]>([]);
  /** Bumps on every successful pull — the pill decorations re-resolve on it. */
  readonly stylesRevision = signal(0);

  constructor() {
    void this.refresh();
    effect(() => {
      this.pluginHost.searchChanged();
      void this.refresh();
    });
  }

  /** Resolves one tag's color: longest configured prefix, else auto palette. */
  styleFor(tag: string): TagStyleInfo {
    return resolveTagStyle(tag, this.prefixes());
  }

  private async refresh(): Promise<void> {
    try {
      const payload = await window.dreyApi.searchVocabulary();
      this.entries.set(payload.entries);
      this.prefixes.set(payload.prefixes);
      this.stylesRevision.update((n) => n + 1);
    } catch {
      // No provider / IPC failure: degrade to empty, keep last good data.
    }
  }
}
