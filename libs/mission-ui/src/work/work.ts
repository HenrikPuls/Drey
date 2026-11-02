import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import {
  MC_WORK_STATE,
  fleetLabelOf,
  groupsOf,
  liveRunCountOf,
  nextPhaseOf,
  questionCardOf,
  ticketPersonaOf,
  vaultTitleOf,
  type McAnswerReply,
  type McBoard,
  type McMoveResult,
  type McPersona,
  type McScoutReport,
  type NeedVm,
  type QuestionCardVm,
  type TicketVm,
  type WorkGroup,
} from './work.model';

/**
 * The work tab (concept §7): the header — logo, "Arbeit" title, the
 * vault's name as the mono sub, the Fleet chip (live-run count, idle
 * face without run data) — then the Braucht-dich group first and the
 * board's phase groups in order: groups, not kanban columns. One ticket
 * = one card in the prototype's dress (id, phase chip, persona pill,
 * amber wait-line when blocked, priority flag; the cost and ctx slots
 * appear only when the desk sends data). The card tap opens the bottom
 * sheet with the move/close actions in the thumb's reach. A scout
 * report need (E8) renders its report — stamp, summary, the decision
 * options — plus the promote action that prefills the chat.
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

  /** The header sub: the board's vault name; null hides the line. */
  protected readonly vaultTitle = computed(() => vaultTitleOf(this.state?.board ?? null));

  /** The fleet's live-run count; null = no run data in the state. */
  protected readonly liveRuns = computed(() => liveRunCountOf(this.state?.runs ?? null));

  /** The chip's label: `<n> aktiv` with data, the bare word without. */
  protected readonly fleetLabel = computed(() => fleetLabelOf(this.liveRuns()));

  /** The chip's LED face: mint and pulsing while runs are live, idle otherwise. */
  protected readonly fleetLive = computed(() => (this.liveRuns() ?? 0) > 0);

  /** The Fleet chip's tap: a status note, only when runs are actually live. */
  protected onFleetTap(): void {
    const count = this.liveRuns();
    if (count !== null && count > 0) {
      this.state?.toast?.(`Runner: ${count} Runs live`, 'ok');
    }
  }

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

  /** A need card whose ticket is on the board opens it (the prototype's
   *  proof teaser taps through to the ticket screen). */
  protected openNeedTicket(vm: NeedVm): void {
    const id = vm.need.ticketId;
    if (id !== null && id !== undefined && this.state?.openTicket !== undefined) {
      this.state.openTicket(id);
    }
  }

  /**
   * An improvements need is tappable only when the state adapter offers
   * `openPersona` (the shell binds it; absent = the card stays a note).
   */
  protected needTappable(vm: NeedVm): boolean {
    return this.state?.openPersona !== undefined && vm.need.kind === 'improvements';
  }

  /** The report need's parsed report; null = the desk sent the headline only. */
  protected reportOfNeed(vm: NeedVm): McScoutReport | null {
    return vm.need.report ?? null;
  }

  /**
   * The promote action shows on a report card only when the adapter
   * offers `promote` and the device may act: a read-only device watches,
   * it never promotes (the move button's rule).
   */
  protected canPromote(vm: NeedVm): boolean {
    return (
      !this.readOnly() &&
      this.state?.promote !== undefined &&
      vm.need.kind === 'report' &&
      (vm.need.ticketId ?? '') !== ''
    );
  }

  /**
   * The promote tap: the adapter prefills the chat with the promote
   * command and switches to the chat tab — the send stays the owner's
   * (the desk answers with the proposal card the confirmation needs).
   */
  protected promoteTicket(vm: NeedVm): void {
    const ticketId = vm.need.ticketId;
    if (
      ticketId === undefined ||
      ticketId === null ||
      ticketId === '' ||
      this.state?.promote === undefined
    ) {
      return;
    }
    this.state.promote(ticketId);
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

  // --- the question option card ('Auswahl nie = Aktion') -------------------------

  /** The question need's option card; null = the plain question text renders alone. */
  protected questionCardOfNeed(vm: NeedVm): QuestionCardVm | null {
    return questionCardOf(vm.need);
  }

  /** The card's persona (the board's pin resolved) — the chip and the done line read it. */
  protected needPersona(vm: NeedVm): McPersona | null {
    const state = this.state;
    const ticketId = vm.need.ticketId;
    if (state === null || ticketId === null || ticketId === undefined || ticketId === '') {
      return null;
    }
    return ticketPersonaOf(state.board as McBoard | null, ticketId, state.personas);
  }

  /** The done line's persona label: the persona title, the ticket id as fallback. */
  protected personaLabelOf(vm: NeedVm): string {
    return this.needPersona(vm)?.title ?? vm.need.ticketId ?? 'die Persona';
  }

  /** The selected option per need key — a tap only marks ('Auswahl nie = Aktion'). */
  private readonly qSelected = signal<Readonly<Record<string, number>>>({});
  private readonly qPending = signal<Readonly<Record<string, boolean>>>({});
  private readonly qDone = signal<Readonly<Record<string, boolean>>>({});
  private readonly qError = signal<Readonly<Record<string, string>>>({});

  protected qSelectedIndex(vm: NeedVm): number | null {
    return this.qSelected()[vm.key] ?? null;
  }

  protected qIsPending(vm: NeedVm): boolean {
    return this.qPending()[vm.key] === true;
  }

  /** True once an answer landed — the mint done line takes over the card. */
  protected qIsDone(vm: NeedVm): boolean {
    return this.qDone()[vm.key] === true;
  }

  protected qErrorOf(vm: NeedVm): string | null {
    const value = this.qError()[vm.key];
    return value === undefined || value === '' ? null : value;
  }

  /** The send button's dynamic label: `"<Option>" senden`. */
  protected qSendLabel(card: QuestionCardVm, vm: NeedVm): string {
    const at = this.qSelectedIndex(vm);
    const option = at === null ? null : card.options[at];
    return option === null || option === undefined ? 'Antwort senden' : `„${option.label}“ senden`;
  }

  /** Marks the tapped option; nothing sends until the send row's button fires. */
  protected qSelect(vm: NeedVm, index: number): void {
    if (this.readOnly() || this.qIsDone(vm) || this.qIsPending(vm)) {
      return;
    }
    this.qSelected.update((current) => ({ ...current, [vm.key]: index }));
  }

  /** The send row appears once an option carries the selection. */
  protected qHasSelection(vm: NeedVm): boolean {
    return this.qSelectedIndex(vm) !== null;
  }

  /**
   * The one acting tap: the chosen option's answer goes to the run, the
   * card turns into its mint done line, and the need disappears with the
   * next needs refresh (the desk clears it once answered). A refusal
   * shows inline and leaves the card answerable.
   */
  protected async qSend(vm: NeedVm, card: QuestionCardVm): Promise<void> {
    const state = this.state;
    const at = this.qSelectedIndex(vm);
    const option = at === null ? undefined : card.options[at];
    const runId = card.runId;
    if (state === null || state.answer === undefined || option === undefined || runId === null) {
      return;
    }
    this.qPending.update((current) => ({ ...current, [vm.key]: true }));
    this.qError.update((current) => ({ ...current, [vm.key]: '' }));
    let reply: McAnswerReply;
    try {
      reply = await state.answer(runId, option.answerText);
    } catch {
      reply = { ok: false, error: 'The answer did not go through.' };
    }
    this.qPending.update((current) => ({ ...current, [vm.key]: false }));
    if (reply.ok) {
      this.qDone.update((current) => ({ ...current, [vm.key]: true }));
      state.toast?.(`Antwort gesendet — ${this.personaLabelOf(vm)} läuft weiter`, 'ok');
    } else {
      this.qError.update((current) => ({ ...current, [vm.key]: reply.error }));
    }
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
