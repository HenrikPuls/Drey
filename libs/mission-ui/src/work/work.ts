import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import {
  MC_WORK_STATE,
  SWIPE_FLASH_MS,
  SWIPE_TAP_SLOP_PX,
  fleetLabelOf,
  groupsOf,
  liveRunCountOf,
  nextPhaseOf,
  questionCardOf,
  swipeActionOf,
  swipeProgressOf,
  ticketPersonaOf,
  vaultTitleOf,
  type McAnswerReply,
  type McBoard,
  type McMoveResult,
  type McPersona,
  type McScoutReport,
  type NeedVm,
  type QuestionCardVm,
  type SwipeAction,
  type TicketVm,
  type WorkGroup,
} from './work.model';

/**
 * The work tab (concept §7): the header — logo, "Work" title, the
 * vault's name as the mono sub, the Fleet chip (live-run count, idle
 * face without run data) — then the Needs-you group first and the
 * board's phase groups in the owner's reading order (closest to done
 * first, the terminal phase last, empty groups gone): groups, not
 * kanban columns. One ticket = one card in the prototype's dress (id,
 * phase chip, persona pill, amber wait-line when blocked, priority
 * flag; the cost and ctx slots appear only when the desk sends data).
 * The card tap opens the ticket screen straight away; a horizontal
 * swipe acts without the card ever moving — an action layer (mint
 * "Move to <next>" right, amber "Send back" left) grows with the
 * distance, past the trigger the release fires the move (the desk's
 * moveOn path) or opens the ticket with its Send-back panel waiting.
 * A scout report need (E8) renders its report — stamp, summary, the
 * decision options — plus the promote action that prefills the chat.
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

  // --- the ticket cards: tap straight through, swipe acts in place ----------

  /**
   * The card tap: straight into the ticket screen — the status lives
   * there now, the old bottom sheet is gone.
   */
  protected openTicketCard(vm: TicketVm): void {
    if (this.state?.openTicket === undefined) {
      return;
    }
    this.state.openTicket(vm.id);
  }

  /** The card the pointer is swiping, with its live deltaX; null = no gesture. */
  protected readonly swipe = signal<{ id: string; deltaX: number } | null>(null);

  /** The fired card's done-optic: the edge flash that plays for a beat after the action. */
  protected readonly swipeFlash = signal<{ id: string; action: SwipeAction } | null>(null);

  private swipeStartX = 0;
  /** A release past the slop was a gesture — the click it leaves behind stays silent. */
  private swallowTap = false;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;

  /** The back-swipe's send-back: only where the adapter parks the panel. */
  private canSendBack(): boolean {
    return this.state?.openTicketSendBack !== undefined;
  }

  /** The forward-swipe's target: the next pipeline phase; null = the card has none. */
  private forwardTargetOf(vm: TicketVm): { phaseId: string; title: string } | null {
    return nextPhaseOf((this.state?.board ?? null) as McBoard | null, vm.phaseId);
  }

  /** Whether the card takes swipes at all: writable, and one side has an action. */
  private swipeable(vm: TicketVm): boolean {
    return !this.readOnly() && (this.canSendBack() || this.forwardTargetOf(vm) !== null);
  }

  protected onCardPointerDown(event: PointerEvent, vm: TicketVm): void {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    if (!this.swipeable(vm)) {
      return;
    }
    this.swipeStartX = event.clientX;
    this.swipe.set({ id: vm.id, deltaX: 0 });
  }

  protected onCardPointerMove(event: PointerEvent): void {
    const current = this.swipe();
    if (current === null) {
      return;
    }
    this.swipe.set({ id: current.id, deltaX: event.clientX - this.swipeStartX });
  }

  protected onCardPointerUp(event: PointerEvent, vm: TicketVm): void {
    const current = this.swipe();
    this.swipe.set(null);
    if (current === null || current.id !== vm.id) {
      return;
    }
    const deltaX = event.clientX - this.swipeStartX;
    if (Math.abs(deltaX) > SWIPE_TAP_SLOP_PX) {
      this.swallowTap = true;
    }
    const action = swipeActionOf(deltaX);
    if (action !== null) {
      void this.fireSwipe(action, vm);
    }
  }

  /** A gesture the browser took over (a scroll) or a pointer that left: quiet reset. */
  protected onCardPointerCancel(): void {
    this.swipe.set(null);
  }

  /** The card's click: a tap after a real gesture does nothing, else the ticket opens. */
  protected onCardTap(vm: TicketVm): void {
    if (this.swallowTap) {
      this.swallowTap = false;
      return;
    }
    this.openTicketCard(vm);
  }

  /**
   * The action layer while the pointer is down: the swiped side's label
   * and how far it has grown (0..1); null at rest, on the wrong side or
   * where that side has no action (no next phase → no mint layer).
   */
  protected swipeLayerOf(vm: TicketVm): {
    side: SwipeAction;
    label: string;
    progress: number;
    widthPercent: number;
  } | null {
    const current = this.swipe();
    if (current === null || current.id !== vm.id || current.deltaX === 0) {
      return null;
    }
    const progress = swipeProgressOf(current.deltaX);
    if (current.deltaX > 0) {
      const target = this.forwardTargetOf(vm);
      if (target === null) {
        return null;
      }
      return {
        side: 'forward',
        label: `Move to ${target.title} →`,
        progress,
        widthPercent: Math.round(progress * 38),
      };
    }
    if (!this.canSendBack()) {
      return null;
    }
    return { side: 'back', label: '← Send back', progress, widthPercent: Math.round(progress * 38) };
  }

  /** The release flash's class: the fired card's edge lights its side's colour. */
  protected isFlashing(vm: TicketVm, action: SwipeAction): boolean {
    const flash = this.swipeFlash();
    return flash !== null && flash.id === vm.id && flash.action === action;
  }

  /**
   * The fired swipe: the flash plays at once; back opens the ticket with
   * the Send-back panel waiting, forward moves the card on through the
   * desk's move path — a refusal surfaces on the toast (the sheet that
   * used to show it inline is gone).
   */
  private async fireSwipe(action: SwipeAction, vm: TicketVm): Promise<void> {
    const state = this.state;
    if (state === null || this.readOnly()) {
      return;
    }
    if (action === 'back') {
      if (state.openTicketSendBack === undefined) {
        return;
      }
      this.flashSwipe(vm.id, action);
      state.openTicketSendBack(vm.id);
      return;
    }
    const target = this.forwardTargetOf(vm);
    if (target === null) {
      return;
    }
    this.flashSwipe(vm.id, action);
    let result: McMoveResult;
    try {
      result = await state.moveTicket(vm.id, target.phaseId);
    } catch {
      result = { ok: false, error: 'The move failed.' };
    }
    if (!result.ok) {
      state.toast?.(result.error ?? 'The move failed.', 'error');
    }
  }

  private flashSwipe(id: string, action: SwipeAction): void {
    if (this.flashTimer !== null) {
      clearTimeout(this.flashTimer);
    }
    this.swipeFlash.set({ id, action });
    this.flashTimer = setTimeout(() => {
      this.flashTimer = null;
      this.swipeFlash.set(null);
    }, SWIPE_FLASH_MS);
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

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (this.flashTimer !== null) {
        clearTimeout(this.flashTimer);
      }
    });
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
    return this.needPersona(vm)?.title ?? vm.need.ticketId ?? 'the persona';
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
    return option === null || option === undefined ? 'Send answer' : `Send “${option.label}”`;
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
      state.toast?.(`Answer sent — ${this.personaLabelOf(vm)} keeps running`, 'ok');
    } else {
      this.qError.update((current) => ({ ...current, [vm.key]: reply.error }));
    }
  }
}
