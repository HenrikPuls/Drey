import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import {
  MC_WORK_STATE,
  groupsOf,
  nextPhaseOf,
  type McMoveResult,
  type NeedVm,
  type TicketVm,
  type WorkGroup,
} from './work.model';

/**
 * The work tab (concept §7): the needs-you group first, then the board's
 * phase groups in order — groups, not kanban columns. One ticket = one
 * card (id, title, phase chip, persona chip, priority flag, blocked
 * marker); the card tap opens the bottom sheet with the move/close
 * actions in the thumb's reach.
 */
@Component({
  selector: 'mc-work',
  templateUrl: './work.html',
  styleUrl: './work.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Work {
  /** The device state slice; null until the shell binds McState to it. */
  protected readonly state = inject(MC_WORK_STATE, { optional: true });

  protected readonly groups = computed<WorkGroup[]>(() => {
    const state = this.state;
    return state === null ? [] : groupsOf(state.needs, state.board, state.personas);
  });

  protected readonly readOnly = computed(() => this.state?.readOnly ?? false);

  /** The card whose bottom sheet is open. */
  protected readonly openCard = signal<TicketVm | null>(null);
  protected readonly moveError = signal<string | null>(null);
  protected readonly movePending = signal(false);

  /** The sheet's primary action: the next phase group, null when there is none. */
  protected readonly moveTarget = computed(() => {
    const card = this.openCard();
    if (card === null) {
      return null;
    }
    const next = nextPhaseOf(this.groups(), card.phaseId);
    return next === null ? null : { phaseId: next.phaseId, title: next.title };
  });

  protected openSheet(card: TicketVm): void {
    this.openCard.set(card);
    this.moveError.set(null);
    this.movePending.set(false);
  }

  protected closeSheet(): void {
    this.openCard.set(null);
    this.moveError.set(null);
    this.movePending.set(false);
  }

  /** The sheet's "Open ticket": the ticket screen takes over (E5c). */
  protected openTicket(): void {
    const card = this.openCard();
    if (card === null || this.state?.openTicket === undefined) {
      return;
    }
    this.state.openTicket(card.id);
    this.closeSheet();
  }

  /**
   * An improvements need is tappable only when the state adapter offers
   * `openPersona` (the shell binds it; absent = the card stays a note).
   */
  protected needTappable(vm: NeedVm): boolean {
    return this.state?.openPersona !== undefined && vm.need.kind === 'improvements';
  }

  /**
   * The improvements need's tap: the need item's title IS the persona
   * title (the engine's guarantee). It is matched against the persona
   * directory at call time — the directory may arrive after the needs
   * list — and the resolved id goes to the adapter; an unknown persona
   * falls back to the raw title, which the adapter also accepts.
   */
  protected openNeedPersona(vm: NeedVm): void {
    const state = this.state;
    if (state?.openPersona === undefined || vm.need.kind !== 'improvements') {
      return;
    }
    const persona = state.personas.find((known) => known.title === vm.need.title);
    state.openPersona(persona?.id ?? vm.need.title);
  }

  /** "Move to next phase": the card on to the next group; the error shows inline. */
  protected async moveOn(): Promise<void> {
    const state = this.state;
    const card = this.openCard();
    const target = this.moveTarget();
    if (state === null || card === null || target === null || this.readOnly()) {
      return;
    }
    this.movePending.set(true);
    this.moveError.set(null);
    let result: McMoveResult;
    try {
      result = await state.moveTicket(card.id, target.phaseId);
    } catch {
      result = { ok: false, error: 'The move failed.' };
    }
    this.movePending.set(false);
    if (result.ok) {
      this.closeSheet();
    } else {
      this.moveError.set(result.error ?? 'The move failed.');
    }
  }
}
