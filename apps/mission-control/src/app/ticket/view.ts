import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { renderMarkdown, type MdBlock } from './markdown';
import { isJumpPriority } from '../api/dto';
import {
  ACCEPT_ARM_WINDOW_MS,
  ACCEPT_DISARMED,
  DEFAULT_DIFF_FONT_SIZE,
  MC_TICKET,
  acceptArmReduce,
  blockerNoteOf,
  chainPrefillOf,
  chainStepsOf,
  diffFontSizeStep,
  patchLineKind,
  phaseTitleOf,
  proofOf,
  renderChainEntryViews,
  scoutReportOf,
  splitTicketSections,
  type AcceptArmState,
  type GateStep,
  type ProofReport,
  type ScoutReport,
  type TicketBlockerNote,
  type TicketDiffFile,
} from './ticket.model';

/** One inline action result: an error line, or the dim confirmation that closes nothing. */
export interface TicketScreenResult {
  readonly kind: 'error' | 'note';
  readonly text: string;
}

/** One screenshot thumbnail in the proof card's swipeable row. */
export interface ProofShot {
  readonly name: string;
  readonly url: string;
}

/**
 * The ticket screen (concept §5.3–5.5): the destination every card
 * points to. Header with the back arrow, id, title and phase chip; the
 * gate bar over the merged gate chain (E9, concept §5.7: the standard
 * flow plus the ticket's `chain:` delta — inserted gates wear the
 * addition mark, skipped ones strike through, the Bescheid rule rings);
 * the bar is tappable and opens the gate sheet — the three most common
 * chain interventions, each prefilling the chat's setChain command; the
 * ticket body as safe Markdown blocks; the `## Verification` section as
 * the proof card (criteria checklist, the swipeable screenshot gallery,
 * findings); the `## Report` section as the scout report card (E8: the
 * stamp, the summary, the decision options — a scout ticket's endpoint);
 * below it the diff as git rendered — collapsible files, the +/-
 * balance, a fullscreen patch viewer with stepped font size. The
 * actions row sits at the bottom in the thumb's reach: the armed
 * two-step Accept, the send-back panel with its mandatory note, and the
 * Edit toggle that hands the raw file to `mc-ticket-edit` (the exception
 * path, §5.5). Read-only paired devices watch: their actions hide
 * entirely, and the gate bar opens no sheet.
 */
@Component({
  selector: 'mc-ticket',
  templateUrl: './view.html',
  styleUrl: './view.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TicketView {
  protected readonly vm = inject(MC_TICKET);

  // --- the rendered ticket -------------------------------------------------

  /** The open ticket's document; null = the screen's empty/loading/error state. */
  protected readonly doc = computed(() => this.vm.doc());

  protected readonly isEmpty = computed(() => this.doc() === null);

  protected readonly id = computed(() => this.doc()?.id ?? '');

  protected readonly title = computed(() => {
    const doc = this.doc();
    if (doc === null) {
      return '';
    }
    const title = doc.title.trim();
    return title === '' ? doc.id : title;
  });

  protected readonly phaseTitle = computed(() => {
    const doc = this.doc();
    return doc === null ? '' : phaseTitleOf(doc.phases, doc.phase);
  });

  protected readonly phaseColor = computed(() => this.vm.phaseColor());

  protected readonly readOnly = computed(() => this.vm.readOnly());

  // --- the priority chip and the blocker line ---------------------------------

  /** The ticket's priority id — the chip's label; null = no chip. */
  protected readonly priority = computed(() => this.doc()?.priority ?? null);

  /** True when the priority sits in the configured vocabulary's jump class. */
  protected readonly priorityJump = computed(() =>
    isJumpPriority(this.priority(), this.doc()?.priorities ?? []),
  );

  /** The blocker line's note; null = the ticket names no dependencies. */
  protected readonly blockers = computed<TicketBlockerNote | null>(() => {
    const doc = this.doc();
    return doc === null ? null : blockerNoteOf(doc.blocked, doc.blockedBy);
  });

  protected readonly steps = computed<GateStep[]>(() => {
    const doc = this.doc();
    return doc === null ? [] : chainStepsOf(doc.phases, doc.phase, doc.chain);
  });

  // --- the gate sheet (E9, concept §5.7) ----------------------------------------

  /** The bottom sheet the tappable gate bar opens: the three chain interventions. */
  protected readonly sheetOpen = signal(false);
  /** The insert form: which phase, hung where, and whether it raises the Bescheid. */
  protected readonly insertPhase = signal('');
  protected readonly insertPosition = signal<'after' | 'before'>('after');
  protected readonly insertAnchor = signal('');
  protected readonly insertNotify = signal(false);
  /** The notify form: which gate's completion lands a card in "Needs you". */
  protected readonly notifyGate = signal('');

  /** The ticket's own delta entries, canonically rendered. */
  private readonly chainTexts = computed<readonly string[]>(() => {
    const doc = this.doc();
    return doc === null ? [] : renderChainEntryViews(doc.chain);
  });

  /** True when the ticket deviates from the standard flow. */
  protected readonly hasDelta = computed(() => this.chainTexts().length > 0);

  /** The insert form's phase options — the whole pipeline, anything may be revisited. */
  protected readonly insertPhaseOptions = computed(() => this.doc()?.phases ?? []);

  /**
   * The anchor/notify options — the current and the future gates. The
   * desk's validateChain refuses a past anchor and news from a past
   * gate, so the sheet never offers them.
   */
  private readonly openSteps = computed<readonly GateStep[]>(() =>
    this.steps().filter((step) => step.state !== 'past'),
  );

  protected readonly anchorOptions = computed(() => this.openSteps());

  /** The notify picker's gates — those without the Bescheid rule standing yet. */
  protected readonly notifyOptions = computed(() => this.openSteps().filter((step) => !step.notify));

  /** The insert form's would-be entry; null while phase or anchor is unchosen. */
  private readonly insertEntryText = computed<string | null>(() => {
    const phase = this.insertPhase();
    const anchor = this.insertAnchor();
    if (phase === '' || anchor === '' || phase === anchor) {
      return null;
    }
    const opts = this.insertNotify() ? '(notify)' : '';
    return `insert ${phase}${opts} ${this.insertPosition()} ${anchor}`;
  });

  /** True when the insert form adds nothing the delta does not already hold. */
  protected readonly insertDisabled = computed(() => {
    const entry = this.insertEntryText();
    if (entry === null) {
      return true;
    }
    return this.chainTexts().includes(entry);
  });

  /** True when the notify picker adds nothing new (the gate already rings). */
  protected readonly notifyDisabled = computed(() => {
    const gate = this.notifyGate();
    const step = this.steps().find((known) => known.id === gate);
    return gate === '' || step === undefined || step.notify;
  });

  protected openSheet(): void {
    if (this.isEmpty()) {
      return;
    }
    const open = this.openSteps();
    const current = this.steps().find((step) => step.state === 'current');
    this.insertPhase.set(this.doc()?.phases[0]?.id ?? '');
    this.insertPosition.set('after');
    this.insertAnchor.set(current?.id ?? open[0]?.id ?? '');
    this.insertNotify.set(false);
    this.notifyGate.set(current?.id ?? open[0]?.id ?? '');
    this.sheetOpen.set(true);
  }

  protected closeSheet(): void {
    this.sheetOpen.set(false);
  }

  protected onInsertPhase(event: Event): void {
    this.insertPhase.set((event.target as HTMLSelectElement).value);
  }

  protected onInsertPosition(event: Event): void {
    this.insertPosition.set((event.target as HTMLSelectElement).value === 'before' ? 'before' : 'after');
  }

  protected onInsertAnchor(event: Event): void {
    this.insertAnchor.set((event.target as HTMLSelectElement).value);
  }

  protected onInsertNotify(event: Event): void {
    this.insertNotify.set((event.target as HTMLInputElement).checked);
  }

  protected onNotifyGate(event: Event): void {
    this.notifyGate.set((event.target as HTMLSelectElement).value);
  }

  /** Insert gate: prefill the chat with the delta plus the form's entry. */
  protected prefillInsert(): void {
    const entry = this.insertEntryText();
    const doc = this.doc();
    if (entry === null || doc === null) {
      return;
    }
    this.propose([...this.chainTexts(), entry]);
  }

  /** Set notify rule: prefill the chat with the delta plus the Bescheid entry. */
  protected prefillNotify(): void {
    const gate = this.notifyGate();
    const doc = this.doc();
    if (gate === '' || doc === null) {
      return;
    }
    this.propose([...this.chainTexts(), `notify ${gate}`]);
  }

  /** Back to the standard flow: prefill the chat with the empty delta. */
  protected prefillStandard(): void {
    if (this.doc() === null) {
      return;
    }
    this.propose([]);
  }

  /** The one mutation path: the sheet's draft becomes the chat composer's command. */
  private propose(entries: readonly string[]): void {
    const doc = this.doc();
    if (doc === null) {
      return;
    }
    this.sheetOpen.set(false);
    this.vm.proposeChain(chainPrefillOf(doc.id, entries));
  }

  private readonly sections = computed(() => {
    const doc = this.doc();
    return doc === null ? splitTicketSections('') : splitTicketSections(doc.text);
  });

  protected readonly blocks = computed<readonly MdBlock[]>(() => renderMarkdown(this.sections().body));

  /** The proof card's data; null = the ticket carries no Verification section. */
  protected readonly proof = computed<ProofReport | null>(() => {
    const verification = this.sections().verification;
    return verification === null ? null : proofOf(verification);
  });

  /** The scout report card's data (E8); null = the ticket carries no Report section. */
  protected readonly report = computed<ScoutReport | null>(() => {
    const section = this.sections().report;
    return section === null ? null : scoutReportOf(section);
  });

  /** The criteria's screenshot attachments resolvable to a URL, for the gallery. */
  protected readonly shots = computed<readonly ProofShot[]>(() => {
    const proof = this.proof();
    if (proof === null) {
      return [];
    }
    const out: ProofShot[] = [];
    for (const criterion of proof.criteria) {
      if (criterion.screenshot === null) {
        continue;
      }
      const url = this.vm.attachmentUrl(criterion.screenshot);
      if (url !== null) {
        out.push({ name: criterion.screenshot, url });
      }
    }
    return out;
  });

  protected readonly diff = computed(() => this.vm.diff());

  // --- the inline result -----------------------------------------------------

  protected readonly result = signal<TicketScreenResult | null>(null);

  /** The dim save confirmation the editor set through `vm.flashSaved()`; it closes nothing. */
  protected readonly savedFlash = computed(() => this.vm.savedFlash());

  // --- the armed two-step Accept ---------------------------------------------

  protected readonly arm = signal<AcceptArmState>(ACCEPT_DISARMED);
  protected readonly acceptPending = signal(false);
  private armTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.clearArmTimer());
  }

  protected acceptTap(): void {
    if (this.acceptPending() || this.readOnly() || this.isEmpty()) {
      return;
    }
    const outcome = acceptArmReduce(this.arm(), { kind: 'tap', now: Date.now() });
    this.arm.set(outcome.state);
    this.clearArmTimer();
    if (outcome.execute) {
      void this.doAccept();
    } else if (outcome.state.armed) {
      this.armTimer = setTimeout(() => {
        this.arm.set(acceptArmReduce(this.arm(), { kind: 'tick', now: Date.now() }).state);
      }, ACCEPT_ARM_WINDOW_MS);
    }
  }

  private async doAccept(): Promise<void> {
    this.acceptPending.set(true);
    this.result.set(null);
    try {
      const reply = await this.vm.accept();
      this.result.set(
        reply.ok
          ? { kind: 'note', text: reply.warning ?? 'Accepted.' }
          : { kind: 'error', text: reply.error ?? 'The accept failed.' },
      );
    } catch {
      this.result.set({ kind: 'error', text: 'The accept failed.' });
    } finally {
      this.acceptPending.set(false);
      this.arm.set(ACCEPT_DISARMED);
    }
  }

  private clearArmTimer(): void {
    if (this.armTimer !== null) {
      clearTimeout(this.armTimer);
      this.armTimer = null;
    }
  }

  // --- the send-back panel -----------------------------------------------------

  protected readonly sendBackOpen = signal(false);
  protected readonly note = signal('');
  protected readonly sendBackPending = signal(false);

  protected toggleSendBack(): void {
    if (this.readOnly() || this.isEmpty()) {
      return;
    }
    this.sendBackOpen.update((open) => !open);
    this.note.set('');
  }

  protected onNote(event: Event): void {
    this.note.set((event.target as HTMLTextAreaElement).value);
  }

  protected async sendBack(): Promise<void> {
    const note = this.note().trim();
    if (note === '' || this.sendBackPending() || this.readOnly()) {
      return;
    }
    this.sendBackPending.set(true);
    this.result.set(null);
    try {
      const reply = await this.vm.sendBack(note);
      if (reply.ok) {
        this.sendBackOpen.set(false);
        this.note.set('');
        this.result.set({ kind: 'note', text: 'Sent back.' });
      } else {
        this.result.set({ kind: 'error', text: reply.error ?? 'The send-back failed.' });
      }
    } catch {
      this.result.set({ kind: 'error', text: 'The send-back failed.' });
    } finally {
      this.sendBackPending.set(false);
    }
  }

  // --- the raw-edit exception path (rendered by mc-ticket-edit) --------------------

  /** The Edit toggle: the vm owns the mode so the view and the editor agree on it. */
  protected toggleEdit(): void {
    if (this.readOnly() || this.isEmpty()) {
      return;
    }
    if (this.vm.editing()) {
      this.vm.exitEdit();
    } else {
      this.vm.enterEdit();
    }
  }

  // --- the diff card -------------------------------------------------------------

  protected readonly expanded = signal<readonly string[]>([]);

  protected isExpanded(path: string): boolean {
    return this.expanded().includes(path);
  }

  protected toggleExpanded(path: string): void {
    this.expanded.update((paths) =>
      paths.includes(path) ? paths.filter((known) => known !== path) : [...paths, path],
    );
  }

  protected readonly fullscreen = signal<TicketDiffFile | null>(null);
  /** The fullscreen patch's font size — one component field, kept across open/close. */
  protected readonly fontSize = signal(DEFAULT_DIFF_FONT_SIZE);

  protected openFullscreen(file: TicketDiffFile, event: Event): void {
    event.stopPropagation();
    this.fullscreen.set(file);
  }

  protected closeFullscreen(): void {
    this.fullscreen.set(null);
  }

  protected stepFont(direction: -1 | 1): void {
    this.fontSize.set(diffFontSizeStep(this.fontSize(), direction));
  }

  protected patchLines(patch: string): readonly string[] {
    return patch.split('\n');
  }

  protected readonly patchLineKind = patchLineKind;

  protected diffStatusClass(status: string): string {
    const letter = status.trim().charAt(0).toLowerCase();
    return letter === '' ? 'diff-status' : `diff-status-${letter}`;
  }

  // --- the screenshot viewer -------------------------------------------------------

  protected readonly viewer = signal<ProofShot | null>(null);

  protected openViewer(shot: ProofShot): void {
    this.viewer.set(shot);
  }

  protected closeViewer(): void {
    this.viewer.set(null);
  }
}
