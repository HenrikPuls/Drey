import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
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
 * Plan to approve (E10-4, concept v2 §5.9, design boards "iPad: Plan to
 * approve" and its phone twin): one card per part of a shaped plan with
 * the builder, the reason, the flow row, the start rule and the build
 * estimate; move and delete (a second press deletes); a released part is
 * locked. Mission Control's proposal sits at the foot with the approval —
 * nothing runs before the tap. The split itself changes in the plan or by
 * asking Mission Control, never here.
 */
@Component({
  selector: 'mc-plan-approve',
  templateUrl: './approve.html',
  styleUrl: './approve.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanApprove {
  private readonly state = inject(MC_APPROVE_STATE);

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
      const estimate = card.locked || builder === null ? null : estimateLineOf(this.state.estimate(approval.gate, builder.id));
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
