import { NgTemplateOutlet } from '@angular/common';
import { effect, ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal, untracked } from '@angular/core';
import { AppBar } from '../app-bar/app-bar';
import { McI18nPipe } from '../i18n/i18n.pipe';
import { AnswerCard } from '../phone/answer-card';
import { PhoneIcon } from '../phone/icon';
import { padSignal, touchFaceSignal } from '../phone/phone';
import { PadCards, type PadCard } from '../shell/pad-card';
import { Panes } from '../shell/panes';
import { MC_WORK_STATE, questionCardOf, questionNeedOf, type QuestionCardVm } from '../work/work.model';
import { planChaptersOf, planSectionOf } from './plan.model';
import { costSoFarText, estimateText as estimateRangeText } from '../../../../shared/cost-text';
import { McI18n } from '../i18n/i18n.service';
import type { McEstimate, McPartCard } from '../api/dto';
import {
  MC_APPROVE_STATE,
  builderOf,
  estimateLineOf,
  flowNoteOf,
  flowSegmentsOf,
  gateLineOf,
  moveRoomOf,
  partBadgeOf,
  personaNameOf,
  proposalOf,
  totalLineOf,
  type McApproveReply,
  type McPartsEdit,
} from './approve.model';

/**
 * Plan to accept (E10-4, concept v2 §5.9, design boards "iPad: Plan to
 * approve" and its phone twin): one card per part of a shaped plan with
 * the builder, the reason, the flow row, the start rule and the build
 * estimate; move and delete (a second press deletes); a released part is
 * locked. Mission Control's proposal sits at the foot with the approval —
 * nothing runs before the tap. The split itself changes in the plan or by
 * asking Mission Control, never here.
 */
@Component({
  selector: 'mc-plan-approve',
  imports: [AnswerCard, AppBar, McI18nPipe, NgTemplateOutlet, PhoneIcon],
  templateUrl: './approve.html',
  styleUrls: ['../phone/kit.css', './approve.css', './pad.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanApprove {
  private readonly state = inject(MC_APPROVE_STATE);
  private readonly i18n = inject(McI18n);
  /** The ticket's open question and its answer, the same call the Work tab's card made. */
  private readonly work = inject(MC_WORK_STATE, { optional: true });

  // --- the phone's plan to accept (board 10j) ----------------------------------

  protected readonly phone = touchFaceSignal();
  protected readonly pad = padSignal();
  private readonly panes = inject(Panes);
  private readonly padCards = inject(PadCards);
  protected readonly moreOpen = signal(false);
  protected readonly goal = signal<string | null>(null);
  protected readonly reply = signal('');
  protected readonly qSelected = signal<number | null>(null);
  protected readonly qBusy = signal(false);
  protected readonly qError = signal<string | null>(null);

  private readonly loadGoal = effect(() => {
    const id = this.approval()?.ticket ?? null;
    const read = this.state.ticketText;
    if (!this.phone() || id === null || read === undefined) {
      return;
    }
    void read(id).then((text) => {
      const chapter = text === null ? undefined : planChaptersOf(planSectionOf(text)).find((c) => c.title.toLowerCase() === 'goal');
      this.goal.set(chapter === undefined ? null : chapter.body.trim());
    });
  });

  protected readonly phoneTitle = computed(() => this.approval()?.title ?? '');

  private readonly planStatus = computed(() => {
    const id = this.approval()?.ticket ?? null;
    return id === null ? null : (this.state.planStatus?.(id) ?? null);
  });

  protected readonly phaseWord = computed(() => {
    const id = this.approval()?.ticket ?? '';
    return this.state.phaseTitle?.(id) ?? '';
  });

  /** The line under the title: the state, plan to accept and the plan's version. */
  protected readonly phoneSub = computed(() => {
    const version = this.planStatus()?.version ?? null;
    return [this.phaseWord(), this.i18n.t('work.phone.plan_to_accept'), version === null ? '' : this.i18n.t('plan.phone.version', { n: version })]
      .filter((bit) => bit !== '')
      .join(' · ');
  });

  /** The plan's flow in words (the first part's: the parts share the standard flow). */
  protected readonly flowLine = computed<string | null>(() => {
    const first = this.approval()?.parts[0];
    return first === undefined || first.flow.length === 0 ? null : first.flow.filter((step) => !step.skipped).map((step) => step.title).join(' · ');
  });

  protected readonly costLine = computed<string | null>(() => {
    const id = this.approval()?.ticket ?? '';
    const spent = this.state.spent?.(id) ?? null;
    const bits = [spent === null ? '' : costSoFarText(this.i18n, spent), this.total() ?? ''];
    const line = bits.filter((bit) => bit !== '').join(' · ');
    return line === '' ? null : line;
  });

  /** A part's estimate as the row says it; a part without a basis says nothing there. */
  protected partEstimate(card: McPartCard): string | null {
    const approval = this.approval();
    const builder = approval === null ? null : builderOf(card, approval);
    if (approval === null || builder === null || card.locked) {
      return null;
    }
    const estimate = this.state.estimate(approval.gate, builder.id);
    return estimate === null ? null : this.i18n.t('cost.amount.estimate', { estimate: estimateRangeText(this.i18n, estimate) });
  }

  protected readonly editCount = computed(() => this.planStatus()?.edits ?? 0);

  /** A part the owner changed since the model's last turn carries the highlight. */
  protected isEdited(title: string): boolean {
    return (this.planStatus()?.marks ?? []).some((mark) => mark.by === 'you' && mark.text.includes(title));
  }

  /** The plan's owner: the persona serving the plan's own phase, else the first with a pick. */
  protected readonly planner = computed(() => {
    const a = this.approval();
    return a === null ? null : (a.personas.find((p) => p.role.toLowerCase().startsWith('plan')) ?? null);
  });

  private readonly questionNeed = computed(() => {
    const id = this.approval()?.ticket ?? null;
    return id === null || this.work === null ? null : questionNeedOf(this.work.needs, id);
  });
  protected readonly questionCard = computed<QuestionCardVm | null>(() => {
    const need = this.questionNeed();
    return need === null ? null : questionCardOf(need);
  });
  protected readonly questionWhy = computed(() => this.questionNeed()?.shaped?.why ?? null);

  protected async qSend(card: QuestionCardVm): Promise<void> {
    const at = this.qSelected();
    const option = at === null ? undefined : card.options[at];
    const answer = this.work?.answer;
    if (option === undefined || card.runId === null || answer === undefined) {
      return;
    }
    this.qBusy.set(true);
    this.qError.set(null);
    try {
      const reply = await answer.call(this.work, card.runId, option.answerText);
      if (reply.ok) {
        this.qSelected.set(null);
      } else {
        this.qError.set(reply.error);
      }
    } finally {
      this.qBusy.set(false);
    }
  }

  protected backToTicket(): void {
    const id = this.approval()?.ticket ?? this.state.open();
    this.state.close();
    if (id !== null) {
      this.state.openTicket(id);
    }
  }

  protected onReply(event: Event): void {
    this.reply.set((event.target as HTMLTextAreaElement).value);
  }

  /** The reply goes to the shape dialog: Mission Control with Paul, with the text in the composer. */
  protected sendReply(): void {
    const text = this.reply().trim();
    if (text !== '') {
      this.state.replyInShape?.(text);
      this.reply.set('');
    }
  }

  protected readonly approval = computed(() => this.state.approval());
  protected readonly error = computed(() => this.state.error());
  protected readonly readOnly = computed(() => this.state.readOnly());
  protected readonly selected = signal<number | null>(null);
  protected readonly picking = signal<number | null>(null);
  /** The card whose delete was pressed once; a second press deletes. */
  protected readonly armed = signal<number | null>(null);
  protected readonly busy = signal(false);
  protected readonly message = signal<string | null>(null);

  protected readonly cards = computed(() => this.approval()?.parts ?? []);

  /** Per card: what the template shows — computed once per change, not per binding. */
  protected readonly rows = computed(() => {
    const approval = this.approval();
    if (approval === null) {
      return [];
    }
    const cards = approval.parts;
    return cards.map((card) => {
      const builder = builderOf(card, approval);
      const estimate = card.locked || builder === null ? null : estimateLineOf(this.i18n, this.state.estimate(approval.gate, builder.id));
      const room = moveRoomOf(cards, card.index);
      return {
        card,
        n: card.index + 1,
        builder,
        tint: builder?.color ?? '',
        who: builder?.title ?? 'Choose a builder',
        badge: partBadgeOf(card),
        flow: flowSegmentsOf(card, approval),
        flowNote: flowNoteOf(card),
        gate: gateLineOf(card.index, cards.length),
        estimate,
        up: room.up,
        down: room.down,
      };
    });
  });

  /** The foot's total: the parts still to run, only those with a basis. */
  protected readonly total = computed(() => {
    const approval = this.approval();
    if (approval === null) {
      return null;
    }
    return totalLineOf(
      this.i18n,
      approval.parts
        .filter((c) => !c.locked)
        .map((c) => {
          const builder = builderOf(c, approval);
          return builder === null ? null : this.state.estimate(approval.gate, builder.id);
        }),
    );
  });

  protected readonly proposal = computed(() => proposalOf(this.cards()));
  protected readonly headline = computed(() => {
    const n = this.cards().length;
    return `${n} ${n === 1 ? 'part' : 'parts'}`;
  });

  protected personaName(id: string | null): string {
    const approval = this.approval();
    return approval === null ? (id ?? '') : personaNameOf(id, approval);
  }

  protected select(card: McPartCard): void {
    this.armed.set(null);
    this.picking.set(null);
    this.message.set(null);
    this.selected.update((now) => (now === card.index ? null : card.index));
  }

  protected togglePick(card: McPartCard): void {
    this.armed.set(null);
    this.picking.update((now) => (now === card.index ? null : card.index));
  }

  protected async pick(card: McPartCard, persona: string): Promise<void> {
    this.picking.set(null);
    await this.run({ op: 'persona', index: card.index, persona });
  }

  protected async move(card: McPartCard, delta: -1 | 1): Promise<void> {
    this.armed.set(null);
    if (await this.run({ op: 'move', from: card.index, to: card.index + delta })) {
      this.selected.set(card.index + delta);
    }
  }

  protected async remove(card: McPartCard): Promise<void> {
    if (this.armed() !== card.index) {
      this.armed.set(card.index);
      return;
    }
    this.armed.set(null);
    if (await this.run({ op: 'delete', index: card.index })) {
      this.selected.set(null);
    }
  }

  private async run(edit: McPartsEdit): Promise<boolean> {
    if (this.busy()) {
      return false;
    }
    this.busy.set(true);
    this.message.set(null);
    try {
      const reply: McApproveReply = await this.state.edit(edit);
      if (!reply.ok) {
        this.message.set(reply.error);
      }
      return reply.ok;
    } finally {
      this.busy.set(false);
    }
  }

  protected async release(scope: 'all' | 'first'): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    this.message.set(null);
    try {
      const reply = await this.state.release(scope);
      if (!reply.ok) {
        this.message.set(reply.error);
      }
    } finally {
      this.busy.set(false);
    }
  }

  protected openTicket(id: string): void {
    this.state.openTicket(id);
  }

  protected changeFlow(card: McPartCard): void {
    this.state.changeFlow(card.index);
  }

  protected changeSplit(): void {
    this.state.changeSplit();
  }

  // --- the iPad's plan to accept (board 5c) ------------------------------------

  protected goToCard(): void {
    this.panes.setRight(true);
  }

  /** The grey paragraph with its mono `### Parts` token cut out of the sentence. */
  protected readonly introParts = computed(() => {
    const mark = '\u0000';
    const [before, after] = this.i18n.t('plan.pad.intro', { code: mark }).split(mark);
    return { before: before ?? '', code: this.i18n.t('plan.pad.parts_code'), after: after ?? '' };
  });

  /** The parts still to release (a released part has its own ticket). */
  private readonly openParts = computed(() => this.cards().filter((card) => !card.locked));
  protected readonly firstCard = computed<McPartCard | null>(() => this.openParts()[0] ?? null);
  protected readonly firstOpen = computed(() => this.firstCard()?.index ?? -1);

  private readonly openEstimates = computed<readonly McEstimate[]>(() => {
    const approval = this.approval();
    if (approval === null) {
      return [];
    }
    return this.openParts()
      .map((card) => {
        const builder = builderOf(card, approval);
        return builder === null ? null : this.state.estimate(approval.gate, builder.id);
      })
      .filter((estimate): estimate is McEstimate => estimate !== null);
  });

  private amountOf(low: number | null, high: number | null, cost: number): string {
    if (low !== null && high !== null) {
      const range = this.i18n.currencyRange(low, high);
      if (range.high !== '') {
        return this.i18n.t('plan.pad.range', { low: range.low, high: range.high });
      }
    }
    return this.i18n.formatCurrency(cost);
  }

  private readonly estimateSum = computed<McEstimate | null>(() => {
    const known = this.openEstimates();
    if (known.length === 0) {
      return null;
    }
    const ranged = known.every((estimate) => estimate.costLow !== null && estimate.costHigh !== null);
    return {
      ...known[0]!,
      runs: Math.min(...known.map((estimate) => estimate.runs)),
      cost: known.reduce((sum, estimate) => sum + estimate.cost, 0),
      costLow: ranged ? known.reduce((sum, estimate) => sum + estimate.costLow!, 0) : null,
      costHigh: ranged ? known.reduce((sum, estimate) => sum + estimate.costHigh!, 0) : null,
    };
  });

  /** `Typical total $3.00–5.20`: the parts that have a basis, summed. */
  protected readonly padTotal = computed(() => {
    const sum = this.estimateSum();
    return sum === null ? this.i18n.t('plan.pad.no_estimate') : this.amountOf(sum.costLow, sum.costHigh, sum.cost);
  });

  /** The Cost row: what was spent, then the estimate with its basis. */
  protected readonly padCost = computed<string | null>(() => {
    const spent = this.state.spent?.(this.approval()?.ticket ?? '') ?? null;
    const sum = this.estimateSum();
    const bits = [spent === null ? '' : costSoFarText(this.i18n, spent), sum === null ? '' : this.i18n.t('cost.amount.estimate', { estimate: estimateRangeText(this.i18n, sum) })];
    const line = bits.filter((bit) => bit !== '').join(' · ');
    return line === '' ? null : line;
  });

  /** A part's cost column: the amount and what it rests on; a released part has none. */
  protected partCost(card: McPartCard): { readonly amount: string; readonly basis: string } | null {
    const approval = this.approval();
    const builder = approval === null ? null : builderOf(card, approval);
    if (approval === null || builder === null || card.locked) {
      return null;
    }
    const estimate = this.state.estimate(approval.gate, builder.id);
    return estimate === null
      ? { amount: this.i18n.t('plan.pad.no_estimate'), basis: this.i18n.t('plan.pad.first_run') }
      : { amount: this.amountOf(estimate.costLow, estimate.costHigh, estimate.cost), basis: this.i18n.t('plan.pad.basis', { n: estimate.runs }) };
  }

  /** The part's second line: when it starts, and why it is a part. */
  protected partSub(card: McPartCard): string {
    return [card.start, card.reason ?? ''].filter((bit) => bit !== '').join(' · ');
  }

  /** The flow card's steps: the first open part's flow, the parts share it unless changed. */
  protected readonly flowSteps = computed<string | null>(() => {
    const flow = this.firstCard()?.flow ?? [];
    return flow.length === 0 ? null : flow.filter((step) => !step.skipped).map((step) => step.title).join(', ');
  });

  private readonly acceptPick = signal<number | null>(null);
  private readonly noLine = computed<string | null>(() => null);

  /** What the Assistant draws for this plan (Q9): its open question, else Accept it as it stands. */
  private readonly publishCard = effect(() => {
    const approval = this.approval();
    if (!this.pad() || approval === null || this.readOnly()) {
      untracked(() => this.padCards.card.set(null));
      return;
    }
    const question = this.questionCard();
    if (question !== null) {
      const card: PadCard = {
        question: question.question,
        why: this.questionWhy(),
        options: question.options,
        selected: this.qSelected,
        busy: this.qBusy,
        error: this.qError,
        done: this.noLine,
        pick: (index) => this.qSelected.set(index),
        send: () => void this.qSend(question),
      };
      untracked(() => this.padCards.card.set(card));
      return;
    }
    if (this.proposal().approveLabel === null) {
      untracked(() => this.padCards.card.set(null));
      return;
    }
    const n = this.openParts().length;
    const names = [...new Set(this.openParts().map((part) => builderOf(part, approval)?.title ?? '').filter((name) => name !== ''))];
    const consequence =
      names.length === 1
        ? this.i18n.t('plan.pad.accept_all_with', { n, name: names[0]! })
        : names.length > 1
          ? this.i18n.t('plan.pad.accept_with', { n, names: names.join(', ') })
          : this.i18n.t('plan.pad.accept_parts', { n });
    const card: PadCard = {
      question: this.i18n.t('plan.pad.accept_q'),
      why: null,
      options: [
        { label: this.i18n.t('plan.pad.accept'), consequence, recommended: true },
        { label: this.i18n.t('plan.pad.change_first'), consequence: this.i18n.t('plan.pad.change_first_line'), recommended: false },
      ],
      selected: this.acceptPick,
      busy: this.busy,
      error: this.message,
      done: this.noLine,
      pick: (index) => this.acceptPick.set(index),
      send: () => {
        const pick = this.acceptPick();
        if (pick === 0) {
          void this.release('all');
        } else if (pick === 1) {
          this.acceptPick.set(null);
          this.changeSplit();
        }
      },
    };
    untracked(() => this.padCards.card.set(card));
  });

  private readonly clearCard = inject(DestroyRef).onDestroy(() => this.padCards.card.set(null));

  protected close(): void {
    this.state.close();
  }
}
