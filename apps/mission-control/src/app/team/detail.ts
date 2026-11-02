import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  InjectionToken,
  computed,
  inject,
  signal,
} from '@angular/core';
import type { ImprovementProposalView, PersonaImprovementsView } from '../api/dto';
import {
  ACCEPT_ARM_WINDOW_MS,
  ACCEPT_DISARMED,
  acceptArmReduce,
  type AcceptArmState,
} from '../ticket/ticket.model';
import { initialsOf } from './team';

// --- pure logic ----------------------------------------------------------------

/**
 * The 1:1's proposal split (E6, concept §4.8): open proposals render as
 * cards on top, accepted/dismissed ones as dim history lines below — the
 * file's order kept inside each bucket.
 */
export interface ProposalSplit {
  readonly open: readonly ImprovementProposalView[];
  readonly history: readonly ImprovementProposalView[];
}

export function proposalsSplitOf(view: PersonaImprovementsView | null): ProposalSplit {
  const open: ImprovementProposalView[] = [];
  const history: ImprovementProposalView[] = [];
  for (const proposal of view?.proposals ?? []) {
    (proposal.state === 'open' ? open : history).push(proposal);
  }
  return { open, history };
}

/** The evidence lines the card shows; the rest is counted, never hidden silently. */
export interface EvidencePreview {
  readonly shown: readonly string[];
  readonly more: number;
}

/** At most three evidence lines on a card — the phone shows the rest on demand. */
export const EVIDENCE_PREVIEW_CAP = 3;

export function evidencePreviewOf(evidence: readonly string[]): EvidencePreview {
  const shown = evidence.slice(0, EVIDENCE_PREVIEW_CAP);
  return { shown, more: Math.max(0, evidence.length - shown.length) };
}

/** The collapsed content preview's line count; the full text is one tap away. */
export const CONTENT_PREVIEW_LINES = 4;

export function contentPreviewOf(content: string): string {
  return content
    .replace(/\n+$/, '')
    .split('\n')
    .slice(0, CONTENT_PREVIEW_LINES)
    .join('\n');
}

// --- the screen's contract -------------------------------------------------------

/** What Apply and Dismiss hand back (the desk's MutationResult slice). */
export interface DetailActionReply {
  readonly ok: boolean;
  readonly error?: string;
}

/** The persona's directory facts the 1:1's header renders. */
export interface PersonaFacts {
  readonly id: string;
  readonly title: string;
  readonly role: string;
  /** `#rrggbb`; the avatar ring's colour. */
  readonly color: string;
}

/**
 * The persona detail's contract — the 1:1 (concept §4.8). The parent
 * binds it over the api layer's persona slice (`personaDetail` /
 * `improvements` / `improvementsError` plus load/apply/dismiss/close);
 * the factory default is the closed, read-only state so the shell works
 * before wiring lands. Every member is a callable: data fields are
 * zero-arg functions (so the component's `computed`s track them), the
 * actions are plain methods closing over the desk client.
 */
export interface TeamDetailVm {
  /** The open persona's id; null = the detail is closed (it renders nothing). */
  open(): { id: string } | null;
  /** The persona's directory facts; null while unknown — the header falls back to the id. */
  persona(): PersonaFacts | null;
  /** The loaded improvements; null while the first fetch runs or it failed. */
  improvements(): PersonaImprovementsView | null;
  /** Why the load failed; null when all is well (the error state retries). */
  loadError(): string | null;
  /** Read-only paired devices watch but never act: Apply/Dismiss hide entirely. */
  readOnly(): boolean;
  /** Re-fetches the open persona's improvements (the error state's retry). */
  reload(): Promise<void>;
  /** The back arrow: the shell closes the detail. */
  close(): void;
  /** Applies the proposal — the desk rewrites its target in one commit. */
  apply(proposal: ImprovementProposalView): Promise<DetailActionReply>;
  /** Dismisses the proposal — the desk records the refusal. */
  dismiss(proposal: ImprovementProposalView): Promise<DetailActionReply>;
}

const CLOSED_DETAIL: TeamDetailVm = {
  open: () => null,
  persona: () => null,
  improvements: () => null,
  loadError: () => null,
  readOnly: () => true,
  reload: () => Promise.resolve(),
  close: () => undefined,
  apply: () => Promise.resolve({ ok: false, error: 'Not connected to a desk.' }),
  dismiss: () => Promise.resolve({ ok: false, error: 'Not connected to a desk.' }),
};

/**
 * The 1:1's state source. The shell binds it over `McState`'s persona
 * slice; the factory default renders nothing (the detail stays closed).
 */
export const MC_TEAM_DETAIL = new InjectionToken<TeamDetailVm>('mc-team-detail', {
  factory: () => CLOSED_DETAIL,
});

// --- the component ---------------------------------------------------------------

/**
 * The persona detail — the 1:1 (concept §4.8): the persona's facts on
 * top (avatar, title, role), the friction count below, then the open
 * proposals as cards — target chip, title, the capped evidence list, a
 * collapsible mono content preview, the lesson when present — each with
 * the armed two-step Apply (the ticket screen's `acceptArmReduce`
 * reducer reused) and a one-tap Dismiss; accepted/dismissed proposals
 * render as dim history lines. Read-only paired devices watch: their
 * actions hide entirely.
 */
@Component({
  selector: 'mc-persona-detail',
  templateUrl: './detail.html',
  styleUrl: './detail.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PersonaDetail {
  private readonly vm = inject(MC_TEAM_DETAIL);

  protected readonly isOpen = computed(() => this.vm.open() !== null);

  /** The persona's facts; null while unknown — the header falls back to the open id. */
  protected readonly persona = computed(() => this.vm.persona());

  protected readonly title = computed(() => {
    const persona = this.persona();
    const title = persona?.title.trim() ?? '';
    return title === '' ? (this.vm.open()?.id ?? '') : title;
  });

  protected readonly role = computed(() => this.persona()?.role ?? '');

  protected readonly color = computed(() => this.persona()?.color ?? '#7aa2f7');

  protected readonly improvements = computed(() => this.vm.improvements());

  protected readonly loadError = computed(() => this.vm.loadError());

  protected readonly readOnly = computed(() => this.vm.readOnly());

  /** True while the first fetch runs: the detail is open, the view empty, no error yet. */
  protected readonly loading = computed(
    () => this.isOpen() && this.improvements() === null && this.loadError() === null,
  );

  /** The empty state: the file exists but holds no proposals yet. */
  protected readonly empty = computed(() => {
    const view = this.improvements();
    return view !== null && view.proposals.length === 0;
  });

  /** The friction line ('<n> unaggregated friction findings'); null when nothing waits. */
  protected readonly frictionLine = computed(() => {
    const count = this.improvements()?.frictionCount ?? 0;
    if (count <= 0) {
      return null;
    }
    return `${count} unaggregated friction finding${count === 1 ? '' : 's'}`;
  });

  protected readonly split = computed(() => proposalsSplitOf(this.improvements()));

  protected readonly initialsOf = initialsOf;
  protected readonly evidencePreviewOf = evidencePreviewOf;
  protected readonly contentPreviewOf = contentPreviewOf;

  // --- the collapsible content previews -------------------------------------------

  protected readonly expanded = signal<readonly string[]>([]);

  protected isExpanded(id: string): boolean {
    return this.expanded().includes(id);
  }

  protected toggleExpanded(id: string): void {
    this.expanded.update((known) => (known.includes(id) ? known.filter((key) => key !== id) : [...known, id]));
  }

  // --- the proposal actions ---------------------------------------------------------

  /** The proposal the Apply arm belongs to — a tap on another card abandons it. */
  protected readonly armTarget = signal<string | null>(null);
  protected readonly arm = signal<AcceptArmState>(ACCEPT_DISARMED);
  private armTimer: ReturnType<typeof setTimeout> | null = null;

  /** The proposal a decision is in flight for; its card shows the busy state. */
  protected readonly busyId = signal<string | null>(null);

  /** The last decision's inline error, keyed to its proposal; null when all is well. */
  protected readonly actionError = signal<{ id: string; text: string } | null>(null);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.clearArmTimer());
  }

  protected busy(proposal: ImprovementProposalView): boolean {
    return this.busyId() === proposal.id;
  }

  protected errorFor(proposal: ImprovementProposalView): string | null {
    const error = this.actionError();
    return error !== null && error.id === proposal.id ? error.text : null;
  }

  /** The armed two-step Apply: the second tap inside the window executes. */
  protected applyTap(proposal: ImprovementProposalView): void {
    if (this.readOnly() || this.busyId() !== null) {
      return;
    }
    // A tap on another card's Apply abandons any arm still in flight.
    if (this.arm().armed && this.armTarget() !== proposal.id) {
      this.disarm();
    }
    const outcome = acceptArmReduce(this.arm(), { kind: 'tap', now: Date.now() });
    this.arm.set(outcome.state);
    this.armTarget.set(outcome.state.armed ? proposal.id : null);
    this.clearArmTimer();
    if (outcome.execute) {
      void this.doApply(proposal);
    } else if (outcome.state.armed) {
      this.armTimer = setTimeout(() => this.disarm(), ACCEPT_ARM_WINDOW_MS);
    }
  }

  private async doApply(proposal: ImprovementProposalView): Promise<void> {
    this.busyId.set(proposal.id);
    this.actionError.set(null);
    try {
      const reply = await this.vm.apply(proposal);
      if (!reply.ok) {
        this.actionError.set({ id: proposal.id, text: reply.error ?? 'The apply failed.' });
      }
    } catch {
      this.actionError.set({ id: proposal.id, text: 'The apply failed.' });
    } finally {
      this.busyId.set(null);
      this.disarm();
    }
  }

  protected async dismiss(proposal: ImprovementProposalView): Promise<void> {
    if (this.readOnly() || this.busyId() !== null) {
      return;
    }
    this.busyId.set(proposal.id);
    this.actionError.set(null);
    try {
      const reply = await this.vm.dismiss(proposal);
      if (!reply.ok) {
        this.actionError.set({ id: proposal.id, text: reply.error ?? 'The dismiss failed.' });
      }
    } catch {
      this.actionError.set({ id: proposal.id, text: 'The dismiss failed.' });
    } finally {
      this.busyId.set(null);
    }
  }

  private disarm(): void {
    this.arm.set(ACCEPT_DISARMED);
    this.armTarget.set(null);
    this.clearArmTimer();
  }

  private clearArmTimer(): void {
    if (this.armTimer !== null) {
      clearTimeout(this.armTimer);
      this.armTimer = null;
    }
  }

  // --- the chrome ---------------------------------------------------------------------

  /** The error state's retry and the header's back arrow both ride on the vm. */
  protected reload(): void {
    void this.vm.reload();
  }

  protected close(): void {
    this.vm.close();
  }
}
