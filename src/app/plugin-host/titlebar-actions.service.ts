import { Injectable, signal } from '@angular/core';
import type { TitlebarActionSpec, Unsubscribe } from '../../../shared/plugin-api/renderer';
import { isIconName, type IconName } from '../icons/icon';

/** One title-bar button as the bar renders it. */
export interface TitlebarActionView {
  readonly key: number;
  readonly spec: TitlebarActionSpec;
  /** The spec's icon when the host's set has it, else null. */
  readonly icon: IconName | null;
}

/**
 * Plugin buttons in the title bar (SDK 1.47): a label, an optional icon and a
 * command to run. The base attaches no meaning to any of them.
 */
@Injectable({ providedIn: 'root' })
export class TitlebarActionsService {
  private nextKey = 1;
  private readonly entries = signal<readonly TitlebarActionView[]>([]);

  readonly actions = this.entries.asReadonly();

  register(spec: TitlebarActionSpec): Unsubscribe {
    const key = this.nextKey++;
    const icon = spec.icon !== undefined && isIconName(spec.icon) ? spec.icon : null;
    this.entries.update((list) => [...list, { key, spec, icon }]);
    return () => this.entries.update((list) => list.filter((entry) => entry.key !== key));
  }
}
