import type { MessageKey } from '../../../shared/i18n';
/**
 * The pure halves of the Settings screen's section tree and search (E13-22):
 * what a page declares, how a query filters the declared entries, and which
 * section the scroll position is in. No DOM, no Angular -- the screen and
 * the specs share these.
 */

/** One expandable entry under a category: a part of that page. */
export interface SettingsSection {
  /** Matches the page's `data-settings-section` anchor element. */
  readonly id: string;
  readonly label: string;
}

/** One searchable setting (or the page itself, when `key` is empty). */
export interface SettingsSearchEntry {
  /** Stable key of the setting; also matched by the search. */
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  /** Who the setting is stored for; unset = not offered under a scope tab. */
  readonly scope?: SettingsScope;
  /** The section of the page the setting sits in. */
  readonly section?: string;
}

/** A search hit: the entry plus where it lives. */
export interface SettingsSearchHit {
  readonly categoryId: string;
  readonly categoryLabel: string;
  readonly sectionLabel: string | null;
  readonly entry: SettingsSearchEntry;
}

export interface SettingsSearchSource {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly description?: string;
  readonly sections?: readonly SettingsSection[];
  readonly entries?: readonly SettingsSearchEntry[];
}

/**
 * Filters the settings of every page: all words of the query must occur in
 * the entry's label, description or key (case-insensitive). A page itself
 * is searchable by its label, hint and description. Order: the pages' own
 * order, a page's own entry first.
 */
export function searchSettings(
  sources: readonly SettingsSearchSource[],
  query: string,
): SettingsSearchHit[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) {
    return [];
  }
  const hits: SettingsSearchHit[] = [];
  for (const source of sources) {
    const own: SettingsSearchEntry = {
      key: '',
      label: source.label,
      description: [source.description, source.hint].filter(Boolean).join(' '),
    };
    const entries = [own, ...(source.entries ?? [])];
    for (const entry of entries) {
      const haystack = `${entry.label} ${entry.description ?? ''} ${entry.key}`.toLowerCase();
      if (words.every((word) => haystack.includes(word))) {
        hits.push({
          categoryId: source.id,
          categoryLabel: source.label,
          sectionLabel: source.sections?.find((s) => s.id === entry.section)?.label ?? null,
          entry,
        });
      }
    }
  }
  return hits;
}

/**
 * The section the page is scrolled to: the last anchor whose top has
 * reached the scrollport's top (plus `offset`). Before the first anchor the
 * first one counts. `anchors` are in page order.
 */
export function activeSection(
  anchors: readonly { readonly id: string; readonly top: number }[],
  scrollTop: number,
  offset: number,
): string | null {
  let current: string | null = anchors[0]?.id ?? null;
  for (const anchor of anchors) {
    if (anchor.top <= scrollTop + offset) {
      current = anchor.id;
    }
  }
  return current;
}

/** Who a setting is stored for (board 7g's scope tabs). */
export type SettingsScope = 'all-devices' | 'device' | 'vault';

export const SETTINGS_SCOPES: readonly { readonly id: SettingsScope; readonly labelKey: MessageKey }[] = [
  { id: 'all-devices', labelKey: 'settings.scope.all_devices' },
  { id: 'device', labelKey: 'settings.scope.device' },
  { id: 'vault', labelKey: 'settings.scope.vault' },
];

/** The hits of one scope tab; `null` (no tab chosen) keeps every hit. */
export function filterHitsByScope(
  hits: readonly SettingsSearchHit[],
  scope: SettingsScope | null,
): SettingsSearchHit[] {
  return scope === null ? [...hits] : hits.filter((hit) => hit.entry.scope === scope);
}

/** How many settings a page, or one of its sections, holds (own page entry excluded). */
export function countSettings(
  entries: readonly SettingsSearchEntry[] | undefined,
  section?: string,
): number {
  return (entries ?? []).filter((entry) => section === undefined || entry.section === section).length;
}
