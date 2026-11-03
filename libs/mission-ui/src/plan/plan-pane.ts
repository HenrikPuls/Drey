import { ChangeDetectionStrategy, Component, computed, inject, input, signal, effect, DestroyRef } from '@angular/core';
import { planStatusLineOf } from '../ticket/ticket.model';
import { renderMarkdown } from '../ticket/markdown';
import {
  MC_PLAN_STATE,
  planChaptersOf,
  planPartsOf,
  planSectionOf,
  replacePlanSection,
  splitLabelOf,
  type McPlanState,
} from './plan.model';

/** Chapters that start open; the rest of the plan starts as a collapsed list. */
const OPEN_BY_DEFAULT: ReadonlySet<string> = new Set(['goal', 'parts']);

/**
 * The shared plan beside the shape dialog (E10-3, concept v2 §5.8, design
 * boards "iPad: Shape the plan" and "Phone: plan sheet"). The plan is a
 * document both sides edit: rendered by default as a list of collapsed
 * chapters, with an Edit toggle that swaps in a text field (the Markdown
 * surface arrives with E12-6). What the owner typed is saved before the
 * next message goes out, so the model reads the same text. Paul's split
 * proposal sits at the foot, where the decision is.
 */
@Component({
  selector: 'mc-plan-pane',
  templateUrl: './plan-pane.html',
  styleUrl: './plan-pane.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanPane {
  private readonly state: McPlanState = inject(MC_PLAN_STATE);

  /** `sheet` = the phone's bottom sheet (grab handle, own close), `pane` = the wide layout's column. */
  readonly mode = input<'pane' | 'sheet'>('pane');

  protected readonly ticket = computed(() => this.state.ticket());
  protected readonly editing = signal(false);
  private readonly draft = signal('');
  private readonly opened = signal<ReadonlySet<string>>(OPEN_BY_DEFAULT);
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly deciding = signal(false);

  protected readonly plan = computed(() => {
    const doc = this.state.doc();
    return doc === null ? null : planSectionOf(doc.text);
  });
  protected readonly empty = computed(() => this.plan() === '');
  protected readonly statusLine = computed(() => {
    const status = this.state.status();
    return status === null ? null : planStatusLineOf(status);
  });
  protected readonly proposal = computed(() => this.state.proposal());
  protected readonly splitLabel = computed(() => splitLabelOf(this.proposal()?.parts ?? 1));
  protected readonly busy = computed(() => this.state.busy?.() ?? false);

  /** The chapters as the collapsed list shows them; the parts chapter carries its parts. */
  protected readonly chapters = computed(() => {
    const plan = this.plan() ?? '';
    const parts = planPartsOf(plan);
    return planChaptersOf(plan).map((chapter) => {
      const key = chapter.title.toLowerCase();
      return {
        title: chapter.title === '' ? 'Plan' : chapter.title,
        key: key === '' ? 'plan' : key,
        blocks: renderMarkdown(chapter.body),
        parts: key === 'parts' ? parts : [],
        summary: key === 'parts' && parts.length > 0 ? `${parts.length}` : '',
      };
    });
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.state.setFlush(null));
    // The ticket changed under the pane (another session opened): leave edit mode.
    effect(() => {
      this.state.ticket();
      this.editing.set(false);
      this.error.set(null);
    });
  }

  protected isOpen(key: string): boolean {
    return this.opened().has(key);
  }

  protected toggle(key: string): void {
    this.opened.update((set) => {
      const next = new Set(set);
      if (!next.delete(key)) {
        next.add(key);
      }
      return next;
    });
  }

  protected draftText(): string {
    return this.draft();
  }

  protected onDraft(event: Event): void {
    this.draft.set((event.target as HTMLTextAreaElement).value);
  }

  /** Edit ⇄ Done: leaving saves what changed. */
  protected async toggleEdit(): Promise<void> {
    if (!this.editing()) {
      this.draft.set(this.plan() ?? '');
      this.error.set(null);
      this.editing.set(true);
      this.state.setFlush(() => this.flush());
      return;
    }
    if (await this.flush()) {
      this.editing.set(false);
      this.state.setFlush(null);
    }
  }

  /** Saves the textarea when it differs from the file; true = nothing is left unsaved. */
  private async flush(): Promise<boolean> {
    const doc = this.state.doc();
    if (!this.editing() || doc === null || this.draft().trim() === (this.plan() ?? '').trim()) {
      return true;
    }
    this.saving.set(true);
    this.error.set(null);
    try {
      const reply = await this.state.save(replacePlanSection(doc.text, this.draft()));
      if (!reply.ok) {
        this.error.set(reply.error);
        return false;
      }
      return true;
    } finally {
      this.saving.set(false);
    }
  }

  protected async decide(choice: 'keep' | 'split'): Promise<void> {
    if (this.deciding()) {
      return;
    }
    this.deciding.set(true);
    this.error.set(null);
    try {
      const reply = await this.state.decide(choice);
      if (!reply.ok) {
        this.error.set(reply.error);
      }
    } finally {
      this.deciding.set(false);
    }
  }
}
