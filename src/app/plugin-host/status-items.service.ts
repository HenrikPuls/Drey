import { Injectable, computed, signal } from '@angular/core';
import { isIconName, type IconName } from '../icons/icon';
import type { StatusItemHandle, StatusItemSpec, Unsubscribe } from '../../../shared/plugin-api/renderer';

/** One status-bar entry as the bar renders it. */
export interface StatusItemView {
  readonly key: number;
  readonly spec: StatusItemSpec;
  /** The spec's icon when the host's set has it, else null. */
  readonly icon: IconName | null;
}

const iconOf = (spec: StatusItemSpec): IconName | null =>
  spec.icon !== undefined && isIconName(spec.icon) ? spec.icon : null;

/**
 * The status-bar slot (SDK 1.38): plugins hand in text / icon / tooltip /
 * command id / priority entries, the bar renders them in priority order.
 * The base attaches no meaning to any of it.
 */
const withSpec = (key: number, spec: StatusItemSpec): StatusItemView => ({ key, spec, icon: iconOf(spec) });

@Injectable({ providedIn: 'root' })
export class StatusItemsService {
  private nextKey = 1;
  private readonly entries = signal<readonly StatusItemView[]>([]);

  /** Visible items: higher priority first, registration order within equal priority. */
  readonly items = computed(() =>
    this.entries()
      .filter((e) => e.spec.text !== '' || e.icon !== null)
      .map((e, index) => ({ e, index }))
      .sort((a, b) => (b.e.spec.priority ?? 0) - (a.e.spec.priority ?? 0) || a.index - b.index)
      .map(({ e }) => e),
  );

  create(spec: StatusItemSpec): StatusItemHandle & { readonly remove: Unsubscribe } {
    const key = this.nextKey++;
    this.entries.update((list) => [...list, { key, spec, icon: iconOf(spec) }]);
    const remove = (): void => {
      this.entries.update((list) => list.filter((e) => e.key !== key));
    };
    return {
      update: (patch) => {
        this.entries.update((list) =>
          list.map((e) => (e.key === key ? withSpec(key, { ...e.spec, ...patch }) : e)),
        );
      },
      dispose: remove,
      remove,
    };
  }
}
