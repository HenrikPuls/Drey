import { Injectable, effect, inject, untracked } from '@angular/core';
import type {
  ConversationTarget,
  ConversationTargetProvider,
  Unsubscribe,
} from '../../../shared/plugin-api/renderer';
import { ViewService } from '../views';

interface Registration {
  readonly pluginId: string;
  readonly provider: ConversationTargetProvider;
  readonly unsubscribe: Unsubscribe;
}

/**
 * The registry behind `conversations.*` (SDK 1.41): plugins offer
 * conversation targets, the Assistant lists them. The base attaches no
 * meaning to a target -- it only collects the providers, fans out their
 * change notices, and carries the active view's default target id (a view
 * preset's `assistantTarget`, ADR-0089) to whoever asks.
 */
@Injectable({ providedIn: 'root' })
export class ConversationTargetsService {
  private readonly views = inject(ViewService);
  private readonly registrations: Registration[] = [];
  private readonly targetListeners = new Set<() => void>();
  private readonly viewListeners = new Set<() => void>();

  constructor() {
    effect(() => {
      this.views.assistantTarget();
      untracked(() => this.fire(this.viewListeners));
    });
  }

  register(pluginId: string, provider: ConversationTargetProvider): Unsubscribe {
    const unsubscribe = provider.onChange(() => this.fire(this.targetListeners));
    const registration: Registration = { pluginId, provider, unsubscribe };
    this.registrations.push(registration);
    this.fire(this.targetListeners);
    return () => {
      const at = this.registrations.indexOf(registration);
      if (at < 0) {
        return;
      }
      this.registrations.splice(at, 1);
      registration.unsubscribe();
      this.fire(this.targetListeners);
    };
  }

  /** Every target, in registration order; the first registration of an id wins. */
  targets(): readonly ConversationTarget[] {
    const seen = new Set<string>();
    const out: ConversationTarget[] = [];
    for (const registration of this.registrations) {
      for (const target of registration.provider.targets()) {
        if (!seen.has(target.id)) {
          seen.add(target.id);
          out.push(target);
        }
      }
    }
    return out;
  }

  onTargetsChange(listener: () => void): Unsubscribe {
    this.targetListeners.add(listener);
    return () => this.targetListeners.delete(listener);
  }

  viewTarget(): string | null {
    return this.views.assistantTarget();
  }

  onViewTargetChange(listener: () => void): Unsubscribe {
    this.viewListeners.add(listener);
    return () => this.viewListeners.delete(listener);
  }

  private fire(listeners: Set<() => void>): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A listener's failure never stops the others.
      }
    }
  }
}
