import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { renderMarkdown, type MdBlock } from './markdown';
import {
  ACCEPT_ARM_WINDOW_MS,
  ACCEPT_DISARMED,
  DEFAULT_DIFF_FONT_SIZE,
  MC_TICKET,
  acceptArmReduce,
  chainPrefillOf,
  chainStepsOf,
  diffFontSizeStep,
  patchRowsOf,
  phaseTitleOf,
  proofOf,
  renderChainEntryViews,
  scoutReportOf,
  splitTicketSections,
  verlaufTextOf,
  type AcceptArmState,
  type GateStep,
  type ProofReport,
  type ScoutReport,
  type TicketDiffFile,
} from './ticket.model';

/** One inline action result: an error line, or the dim confirmation that closes nothing. */
export interface TicketScreenResult {
  readonly kind: 'error' | 'note';
  readonly text: string;
}

/** One screenshot thumbnail in the proof card's swipeable gallery. */
export interface ProofShot {
  readonly name: string;
  readonly url: string;
}

/**
 * The ticket screen (concept §5.3–5.5) in the prototype's look: the
 * header with the 'Arbeit' back label, the mono id and the edit pencil
 * (the raw-edit exception path toggles to `mc-ticket-edit`); the head
 * card with the phase chip, the persona chip and the cost slot (tolerant
 * empty until the engine's stage ledger delivers); the gate bar as pills
 * over the merged gate chain (E9, concept §5.7 — done pills wear the
 * check, the current one the dot and its persona, an inserted one the
 * dashed addition mark, a skipped one the strike-through, the Bescheid
 * rule rings ◎); tappable into the gate sheet, the chain-hint line under
 * it saying so. The body renders as safe Markdown blocks (section heads
 * in mono caps, checkboxes struck, code fences boxed); the `## Verlauf`
 * chapter surfaces as its own yaml box when the file carries one; the
 * `## Verification` section becomes the proof card (the verdict line,
 * the criteria checklist, the snap gallery with its scroll-synced dots
 * and the fullscreen viewer, the findings); the diff renders as the
 * git table — file heads with chevron, path and the +/- balance, the
 * magnifier into the fullscreen zoom, the first file open by default.
 * The actions stay in the thumb's reach: the armed two-step Accept (the
 * mint done ring takes over once accepted), the send-back panel with its
 * mandatory note, and 'Per Chat ändern' prefilling the composer.
 * Read-only paired devices watch: the writing actions hide entirely.
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

  // --- the head card: persona, cost slot, the frontmatter line ---------------

  /**
   * The persona running the current gate — the chip's label; the chain
   * delta can pin it, the plain ladder cannot, so this reads null until
   * a delta names one (tolerant: the chip stays hidden then).
   */
  protected readonly persona = computed(
    () => this.steps().find((step) => step.state === 'current')?.persona ?? null,
  );

  /** The persona's display name: the id with its first letter raised. */
  protected personaTitle(persona: string): string {
    return persona.charAt(0).toUpperCase() + persona.slice(1);
  }

  /**
   * The ticket's accumulated cost for the head card's slot — the engine
   * does not deliver the stage ledger yet, so this reads null and the
   * slot renders nothing (tolerant empty until it does).
   */
  protected readonly cost = computed<string | null>(() => null);

  /** The mono frontmatter line under the title: `phase: x · persona: y`. */
  protected readonly fmLine = computed(() => {
    const doc = this.doc();
    if (doc === null) {
      return '';
    }
    const persona = this.persona();
    return persona === null ? `phase: ${doc.phase}` : `phase: ${doc.phase} · persona: ${persona}`;
  });

  protected readonly steps = computed<GateStep[]>(() => {
    const doc = this.doc();
    return doc === null ? [] : chainStepsOf(doc.phases, doc.phase, doc.chain);
  });

  /**
   * The chain total for the bar's end slot — the costs the engine has
   * delivered so far, summed; null while no gate carries one (the slot
   * renders nothing then, tolerant until the ledger wires up).
   */
  protected readonly costTotal = computed<string | null>(() => {
    const costs = this.steps()
      .map((step) => step.cost)
      .filter((cost) => cost !== null);
    if (costs.length === 0) {
      return null;
    }
    const sum = costs.reduce((acc, cost) => acc + (Number.parseFloat(cost.replace(',', '.')) || 0), 0);
    return `${sum.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
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

  /**
   * The `## Verlauf` chapter as its yaml box reads it — fences stripped,
   * prose kept; null while the ticket carries no chapter (the engine
   * does not write one yet).
   */
  protected readonly verlauf = computed<string | null>(() => {
    const section = this.sections().verlauf;
    return section === null ? null : verlaufTextOf(section);
  });

  /** The proof's pass count for the verdict line; null while there is nothing to count. */
  protected readonly verdict = computed<{ passed: number; total: number; stamp: string } | null>(() => {
    const proof = this.proof();
    if (proof === null || proof.criteria.length === 0) {
      return null;
    }
    return {
      passed: proof.criteria.filter((criterion) => criterion.passed).length,
      total: proof.criteria.length,
      stamp: proof.testedOn,
    };
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
  /** True once an accept landed — the mint done ring takes over the actions. */
  protected readonly accepted = signal(false);
  private armTimer: ReturnType<typeof setTimeout> | null = null;

  /** A fresh ticket starts unaccepted — the ring belongs to one accept only. */
  private readonly resetAcceptedOnTicket = effect(() => {
    this.doc()?.id;
    this.accepted.set(false);
  });

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
      this.accepted.set(reply.ok);
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

  /**
   * The edit pencil in the header: the vm owns the mode so the view and
   * the editor agree on it — the view yields the overlay to the editor
   * while the mode stands.
   */
  protected readonly editing = computed(() => this.vm.editing());

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

  // --- the chat CTA -------------------------------------------------------------

  /**
   * 'Per Chat ändern': the composer inherits the ticket context as the
   * `<id>:` prefix and the owner words the change — the one safe path,
   * nothing writes from here.
   */
  protected changeByChat(): void {
    const doc = this.doc();
    if (doc === null) {
      return;
    }
    const prefill = this.vm.prefillChat ?? this.vm.proposeChain;
    prefill.call(this.vm, `${doc.id}: `);
  }

  // --- the gallery dots ------------------------------------------------------------

  /** The gallery's snap position — the dot wearing the accent. */
  protected readonly galIndex = signal(0);

  /** The scroll-sync: the dot follows the shot the thumb parked on. */
  protected onGalScroll(gal: HTMLElement): void {
    const count = this.shots().length;
    if (count === 0 || gal.scrollWidth === 0) {
      return;
    }
    const step = gal.scrollWidth / count;
    const at = Math.min(Math.max(Math.round(gal.scrollLeft / step), 0), count - 1);
    this.galIndex.set(at);
  }

  /** A dot tap scrolls the gallery to that shot. */
  protected galTo(index: number, gal: HTMLElement): void {
    const count = this.shots().length;
    if (count === 0 || gal.scrollWidth === 0) {
      return;
    }
    gal.scrollTo({ left: (gal.scrollWidth / count) * index, behavior: 'smooth' });
    this.galIndex.set(index);
  }

  // --- the diff card -------------------------------------------------------------

  /** True once the owner toggled a file head — the implicit first-open then retires. */
  private readonly touched = signal(false);

  protected readonly expanded = signal<readonly string[]>([]);

  /**
   * A file is open when the owner opened it; before any tap the diff
   * follows the prototype: the first file starts open, the rest closed.
   */
  protected isExpanded(path: string): boolean {
    if (!this.touched()) {
      return this.diff()?.files[0]?.path === path;
    }
    return this.expanded().includes(path);
  }

  protected toggleExpanded(path: string): void {
    const first = this.diff()?.files[0]?.path;
    const base = !this.touched() && first !== undefined ? [first] : [...this.expanded()];
    this.touched.set(true);
    this.expanded.set(base.includes(path) ? base.filter((known) => known !== path) : [...base, path]);
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

  protected readonly patchRows = patchRowsOf;

  // --- the screenshot viewer -------------------------------------------------------

  protected readonly viewer = signal<ProofShot | null>(null);

  protected openViewer(shot: ProofShot): void {
    this.viewer.set(shot);
  }

  protected closeViewer(): void {
    this.viewer.set(null);
  }
}
