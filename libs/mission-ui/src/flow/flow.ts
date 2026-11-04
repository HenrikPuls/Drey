import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import type { McFlowPersona, McFlowStep } from '../api/dto';
import {
  MC_FLOW_STATE,
  addablePhasesOf,
  changedIndicesOf,
  changesLabelOf,
  eyebrowOf,
  isDirty,
  marksOf,
  moveRoomOf,
  runsAfterOf,
  whoOf,
  type McFlowOp,
} from './flow.model';

/**
 * Flow editor (E10-5, concept v2 §5.7, design boards "iPad: Flow editor"
 * and its phone twin): the gates of one ticket's or one part's flow as a
 * list with a + connector between them, an inspector for the tapped gate
 * (who, model, tell me, runs after, move earlier / later, add after,
 * remove), Paul's draft, "Reset to standard flow" and "Save flow". Every
 * change is a draft, drawn dashed, until Save flow; a running gate stays
 * as it is.
 */
@Component({
  selector: 'mc-flow-editor',
  templateUrl: './flow.html',
  styleUrl: './flow.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FlowEditor {
  private readonly state = inject(MC_FLOW_STATE);

  protected readonly flow = computed(() => this.state.flow());
  protected readonly error = computed(() => this.state.error());
  protected readonly readOnly = computed(() => this.state.readOnly() || (this.state.flow()?.readOnly ?? null) !== null);
  protected readonly reason = computed(() => this.state.paulReason());

  /** The tapped gate (its merged-chain index); null = none. */
  protected readonly selected = signal<number | null>(null);
  /** The connector whose "add a gate" picker is open (the index of the gate it follows). */
  protected readonly adding = signal<number | null>(null);
  protected readonly busy = signal(false);
  protected readonly message = signal<string | null>(null);
  protected readonly ask = signal('');

  protected readonly chip = computed(() => {
    const flow = this.flow();
    return flow === null ? '' : changesLabelOf(flow.chain);
  });
  protected readonly eyebrow = computed(() => {
    const flow = this.flow();
    return flow === null ? 'Flow' : eyebrowOf(flow);
  });
  protected readonly dirty = computed(() => isDirty(this.state.flow(), this.state.saved()));
  protected readonly changed = computed(() => {
    const flow = this.flow();
    return flow === null ? new Set<number>() : changedIndicesOf(flow, this.state.saved());
  });

  /** Per gate: what the row shows, computed once per change. */
  protected readonly rows = computed(() => {
    const flow = this.flow();
    if (flow === null) {
      return [];
    }
    const changed = this.changed();
    return flow.steps.map((step) => {
      const persona = flow.personas.find((p) => p.id === step.persona);
      return {
        step,
        who: whoOf(step, flow),
        tint: persona?.color ?? '',
        model: step.model,
        marks: marksOf(step),
        dashed: changed.has(step.index),
      };
    });
  });

  protected readonly current = computed<McFlowStep | null>(() => {
    const flow = this.flow();
    const at = this.selected();
    return flow === null || at === null ? null : (flow.steps.find((s) => s.index === at) ?? null);
  });

  /** The inspector's facts for the tapped gate. */
  protected readonly inspector = computed(() => {
    const flow = this.flow();
    const step = this.current();
    if (flow === null || step === null) {
      return null;
    }
    const after = runsAfterOf(flow, step);
    const room = moveRoomOf(flow, step);
    const running = step.state === 'current';
    return {
      step,
      who: whoOf(step, flow),
      running,
      editable: !step.locked && !this.readOnly(),
      after: after?.title ?? null,
      earlier: room.earlier,
      later: room.later,
      owner: step.owner,
    };
  });

  /** The personas a gate can be given: a manual step is worked by a human, so only those (E10-6). */
  protected personasFor(step: McFlowStep): readonly McFlowPersona[] {
    const all = this.flow()?.personas ?? [];
    return step.phase === 'manual' || step.phase.startsWith('manual-') ? all.filter((p) => p.kind === 'human') : all;
  }

  protected readonly addable = computed(() => {
    const flow = this.flow();
    return flow === null ? [] : addablePhasesOf(flow);
  });

  protected select(step: McFlowStep): void {
    this.adding.set(null);
    this.message.set(null);
    this.selected.update((now) => (now === step.index ? null : step.index));
  }

  protected toggleAdding(after: number): void {
    this.selected.set(null);
    this.message.set(null);
    this.adding.update((now) => (now === after ? null : after));
  }

  protected async add(phase: string, after: number): Promise<void> {
    const ok = await this.run({ op: 'insert', phase, after });
    if (ok) {
      this.adding.set(null);
      this.selectAdded(phase);
    }
  }

  /** The gate just added opens in the inspector, so the persona can be picked at once. */
  private selectAdded(phase: string): void {
    const added = this.flow()?.steps.find((s) => s.inserted && s.phase === phase);
    if (added !== undefined) {
      this.selected.set(added.index);
    }
  }

  protected setPersona(step: McFlowStep, persona: string | null): Promise<boolean> {
    return this.run({ op: 'persona', step: step.index, persona });
  }

  protected setNotify(step: McFlowStep, on: boolean): Promise<boolean> {
    return this.run({ op: 'notify', step: step.index, on });
  }

  protected async move(step: McFlowStep, dir: -1 | 1): Promise<void> {
    if (await this.run({ op: 'move', step: step.index, dir })) {
      // The gate sits where its neighbour was: follow it with the selection.
      const flow = this.flow();
      const moved = flow?.steps.find((s) => s.phase === step.phase && s.inserted === step.inserted);
      this.selected.set(moved?.index ?? null);
    }
  }

  protected async remove(step: McFlowStep): Promise<void> {
    if (await this.run({ op: 'remove', step: step.index })) {
      this.selected.set(step.inserted ? null : step.index);
    }
  }

  protected restore(step: McFlowStep): Promise<boolean> {
    return this.run({ op: 'restore', step: step.index });
  }

  protected async reset(): Promise<void> {
    if (await this.run({ op: 'reset' })) {
      this.selected.set(null);
      this.adding.set(null);
    }
  }

  protected async askPaul(): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    this.message.set(null);
    try {
      const text = this.ask().trim();
      const reply = await this.state.draft(text === '' ? null : text);
      if (reply.ok) {
        this.ask.set('');
        this.selected.set(null);
        this.adding.set(null);
      } else {
        this.message.set(reply.error);
      }
    } finally {
      this.busy.set(false);
    }
  }

  protected onAsk(event: Event): void {
    this.ask.set((event.target as HTMLInputElement).value);
  }

  protected undoDraft(): void {
    this.state.undoDraft();
    this.selected.set(null);
  }

  protected async save(): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    this.message.set(null);
    try {
      const reply = await this.state.save();
      if (!reply.ok) {
        this.message.set(reply.error);
      }
    } finally {
      this.busy.set(false);
    }
  }

  protected close(): void {
    this.state.close();
  }

  private async run(op: McFlowOp): Promise<boolean> {
    if (this.busy()) {
      return false;
    }
    this.busy.set(true);
    this.message.set(null);
    try {
      const reply = await this.state.edit(op);
      if (!reply.ok) {
        this.message.set(reply.error);
      }
      return reply.ok;
    } finally {
      this.busy.set(false);
    }
  }
}
