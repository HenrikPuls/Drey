import { NgTemplateOutlet } from '@angular/common';
import { effect, ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AppBar } from '../app-bar/app-bar';
import { McI18nPipe } from '../i18n/i18n.pipe';
import { AnswerCard } from '../phone/answer-card';
import { PhoneIcon } from '../phone/icon';
import { touchFaceSignal } from '../phone/phone';
import { MC_WORK_STATE, questionCardOf, questionNeedOf, type QuestionCardVm } from '../work/work.model';
import { planChaptersOf, planSectionOf } from './plan.model';
import { costSoFarText, estimateText as estimateRangeText } from '../../../../shared/cost-text';
import { McI18n } from '../i18n/i18n.service';
import type { McPartCard } from '../api/dto';
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
  styleUrls: ['../phone/kit.css', './approve.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanApprove {
  private readonly state = inject(MC_APPROVE_STATE);
  private readonly i18n = inject(McI18n);
  /** The ticket's open question and its answer, the same call the Work tab's card made. */
  private readonly work = inject(MC_WORK_STATE, { optional: true });

  // --- the phone's plan to accept (board 10j) ----------------------------------

  protected readonly phone = touchFaceSignal();
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

  protected close(): void {
    this.state.close();
  }
}
