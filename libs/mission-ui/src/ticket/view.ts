import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { MC_CHAT_STATE } from '../chat/chat.model';
import {
  MC_WORK_STATE,
  questionCardOf,
  questionNeedOf,
  ticketPersonaOf,
  type McBoard,
  type McNeed,
  type McPersona,
  type QuestionCardVm,
} from '../work/work.model';
import { AppBar } from '../app-bar/app-bar';
import { Markdown } from '../markdown/markdown';
import { planPartsOf, planSectionOf } from '../plan/plan.model';
import {
  ACCEPT_ARM_WINDOW_MS,
  ACCEPT_DISARMED,
  DEFAULT_DIFF_FONT_SIZE,
  MC_TICKET,
  acceptArmReduce,
  chainPrefillOf,
  chainStepsOf,
  changeCountOf,
  costTableOf,
  estimateLineOf,
  changeRowsOf,
  commentLabelOf,
  diffFontSizeStep,
  gateCostOf,
  patchRowsOf,
  planStatusLineOf,
  phaseTitleOf,
  proofOf,
  proofRecommendationOf,
  renderChainEntryViews,
  scoutReportOf,
  sendBackLabelOf,
  splitTicketSections,
  threadItemsOf,
  usdLabelOf,
  verlaufBoxOf,
  verlaufCostsOf,
  verlaufTotalOf,
  viewedKeyOf,
  wholeFileRowsOf,
  type AcceptArmState,
  type ChangeRow,
  type GateStep,
  type ProofReport,
  type ReviewComment,
  type ScoutReport,
  type ThreadItem,
  type TicketDiffFile,
} from './ticket.model';

const titleCaseOf = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

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

/** The ticket screen's three faces: the ticket, its proof, its thread. */
export type TicketMode = 'ticket' | 'proof' | 'thread';

/**
 * The ticket screen (concept §5.3–5.5) in the prototype's look, in three
 * modes the CTA row switches between (the prototype's Ticket→Proof/Thread
 * screens, no routes of their own): the **ticket** mode — the header with
 * the 'Work' back label, the mono id and the edit pencil (the raw-edit
 * exception path toggles to `mc-ticket-edit`); the head card with the
 * phase chip, the persona chip and the cost slot (tolerant empty until
 * the engine's stage ledger delivers); the gate bar as pills over the
 * merged gate chain (E9, concept §5.7) tappable into the gate sheet, the
 * chain-hint line under it saying so; the body renders as safe Markdown
 * blocks (section heads in mono caps, checkboxes struck, code fences
 * boxed); the `## Verlauf` chapter surfaces as its own yaml box; the CTA
 * row carries 'View proof — <n/n> green' (when the Verification
 * criteria exist), 'Answer <persona>'s question' (when a question
 * need waits for the ticket) or the ghost 'Open thread', plus 'Change by
 * chat' prefilling the composer.
 *
 * The **proof** mode (prototype screen 03) gathers what accepting needs:
 * the gate bar with its per-gate costs and the total, the mint verdict
 * box (`<n/n> green.` + the tester's recommendation when the stamp names
 * one), the criteria checklist with their evidence lines, the screenshot
 * gallery with its scroll-synced dots and the fullscreen viewer, the git
 * diff with the magnifier into the fullscreen zoom, and the two owner
 * actions — 'Send back…' with its mandatory note, the armed
 * 'Accept and merge' whose mint done ring takes over once accepted.
 *
 * The **thread** mode (prototype screen 04) is the ticket's filtered
 * view of the active chat session: the messages whose text names the
 * ticket plus the proposal cards whose command does, the question's
 * option card ('Auswahl nie = Aktion' — a tap marks only, the send row
 * acts), and a composer prefilled with the `<id>:` context that sends
 * into the active session like the chat tab does. Read-only paired
 * devices watch: the writing actions hide entirely.
 */
@Component({
  selector: 'mc-ticket',
  templateUrl: './view.html',
  styleUrl: './view.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, Markdown, AppBar],
})
export class TicketView {
  protected readonly vm = inject(MC_TICKET);
  /** The work slice (needs/board/personas): the question CTA and the option card. */
  protected readonly work = inject(MC_WORK_STATE, { optional: true });
  /** The chat slice: the thread's filtered source and its composer's send. */
  protected readonly chat = inject(MC_CHAT_STATE, { optional: true });

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

  // --- the three faces: ticket, proof, thread ---------------------------------

  /** The screen's face; every open resets it to the ticket. */
  protected readonly mode = signal<TicketMode>('ticket');

  protected openProof(): void {
    if (this.isEmpty()) {
      return;
    }
    this.mode.set('proof');
  }

  protected openThread(): void {
    if (this.isEmpty()) {
      return;
    }
    this.mode.set('thread');
    // The composer inherits the ticket context as the `<id>:` prefix —
    // one prefill per open, the owner's own edits keep.
    if (this.threadDraft().trim() === '') {
      this.threadDraft.set(`${this.id()}: `);
    }
  }

  /** Back to the ticket face (the proof/thread header's back arrow). */
  protected backToTicket(): void {
    this.mode.set('ticket');
  }

  /**
   * A fresh ticket starts on its ticket face with a clean thread — the
   * ring belongs to one accept only, and the draft to one open.
   */
  private readonly resetPerTicket = effect(() => {
    this.doc()?.id;
    this.mode.set('ticket');
    this.accepted.set(false);
    this.threadDraft.set('');
    this.threadError.set(null);
    this.threadQSelected.set(null);
    this.threadQPending.set(false);
    this.threadQDone.set(false);
    this.threadQError.set(null);
  });

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
   * The ticket's accumulated cost for the head card's slot — the
   * ledger's settled-run usage the doc carries (`usage.cost`); null when
   * the desk has none (the slot renders nothing, never a 0-fake).
   */
  protected readonly cost = computed<string | null>(() => usdLabelOf(this.doc()?.usage?.cost ?? null));

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
    if (doc === null) {
      return [];
    }
    const costs = verlaufCostsOf(doc.verlauf);
    return chainStepsOf(doc.phases, doc.phase, doc.chain).map((step) => ({
      ...step,
      cost: gateCostOf(costs, step),
    }));
  });

  /**
   * The chain total for the bar's end slot — every `## Verlauf` cost the
   * ticket's chapter carries, summed; null until the runs cost something
   * (the slot renders nothing then, never a 0-fake).
   */
  protected readonly costTotal = computed<string | null>(() => verlaufTotalOf(this.doc()?.verlauf ?? []));

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

  protected readonly sections = computed(() => {
    const doc = this.doc();
    return doc === null ? splitTicketSections('') : splitTicketSections(doc.text);
  });

  /** The ticket text the Markdown surface shows (View by default — it is a result being read). */
  protected readonly bodyText = computed(() => this.sections().body);

  /** The Verification chapter as written, for the proof face's Markdown surface; null = none. */
  protected readonly verificationText = computed(() => this.sections().verification);

  /** Whether the proof face's Verification text is unfolded (it mounts the surface lazily). */
  protected readonly verificationOpen = signal(false);

  /** The proof card's data; null = the ticket carries no Verification section. */
  protected readonly proof = computed<ProofReport | null>(() => {
    const verification = this.sections().verification;
    return verification === null ? null : proofOf(verification);
  });

  /**
   * The `## Verlauf` chapter as its yaml box reads it — one canonical
   * entry per line; null while the ticket carries no readable entries
   * (no chapter, or prose alone), the section then renders nothing.
   */
  protected readonly verlauf = computed<string | null>(() => verlaufBoxOf(this.doc()?.verlauf ?? []));

  /** The shared plan's status line and marked lines (E10-2); null while the desk has no plan state. */
  protected readonly planState = computed(() => {
    const plan = this.vm.plan?.() ?? null;
    if (plan === null) {
      return null;
    }
    const line = planStatusLineOf(plan);
    return line === null && plan.marks.length === 0 ? null : { line, marks: plan.marks };
  });

  /** The comments kept beside the ticket in a dricket store (E14-6), oldest first; empty without any. */
  protected readonly thread = computed(() =>
    (this.doc()?.comments ?? []).map((comment) => ({
      who: comment.author.split('@')[0] ?? comment.author,
      when: comment.at.length >= 16 ? `${comment.at.slice(0, 10)} ${comment.at.slice(11, 16)}` : comment.at,
      text: comment.text,
      signal: comment.verb,
    })),
  );

  /** The cost table at the ticket's end (E11-4); null while no run has settled. */
  protected readonly costTable = computed(() => {
    const doc = this.doc();
    if (doc === null || doc.verlauf.length === 0) {
      return null;
    }
    const titles = new Map(doc.phases.map((phase) => [phase.id.toLowerCase(), phase.title]));
    return costTableOf(doc.verlauf, (id) => titles.get(id.trim().toLowerCase()) ?? titleCaseOf(id));
  });

  /**
   * The estimate for the gate now running: only from the owner's own
   * history and only with at least three similar runs (the desk answers
   * null otherwise), the basis stated in the sentence.
   */
  protected readonly estimateLine = computed<string | null>(() => {
    const current = this.steps().find((step) => step.state === 'current');
    if (current === undefined || current.persona === null || current.persona === undefined) {
      return null;
    }
    const estimate = this.vm.estimate?.(current.id, current.persona) ?? null;
    return estimate === null ? null : estimateLineOf(estimate, current.title);
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

  /** The walkthrough video once its bytes are fetched; null = none, removed, or still loading. */
  protected readonly video = computed<{ name: string; url: string } | null>(() => {
    const name = this.proof()?.video ?? null;
    const url = name === null ? null : (this.vm.videoUrl?.(name) ?? null);
    return name === null || url === null ? null : { name, url };
  });

  protected clock(sec: number): string {
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }

  /** A chapter button seeks the player to its offset. */
  protected seekTo(player: HTMLVideoElement, atSec: number): void {
    player.currentTime = atSec;
    void player.play?.();
  }

  protected readonly diff = computed(() => this.vm.diff());

  // --- the CTA row: proof, thread, per chat -------------------------------------

  /** 'View proof — <n/n> green'; null = the ticket carries no criteria (no CTA). */
  protected readonly proofCta = computed<string | null>(() => {
    const verdict = this.verdict();
    return verdict === null ? null : `View proof — ${verdict.passed}/${verdict.total} green`;
  });

  /** The tester's recommendation for the verdict box; null when the stamp names none. */
  protected readonly proofRecommendation = computed<string | null>(() => {
    const proof = this.proof();
    return proof === null ? null : proofRecommendationOf(proof);
  });

  /** The open question need for this ticket; null = none waits. */
  protected readonly questionNeed = computed<McNeed | null>(() => {
    const work = this.work;
    const doc = this.doc();
    if (work === null || doc === null) {
      return null;
    }
    return questionNeedOf(work.needs, doc.id);
  });

  /** The question's option card; null = the need asks without a readable shape. */
  protected readonly questionCard = computed<QuestionCardVm | null>(() => {
    const need = this.questionNeed();
    return need === null ? null : questionCardOf(need);
  });

  /** The ticket's persona off the board's pin; null when the board carries none. */
  protected readonly questionPersona = computed<McPersona | null>(() => {
    const work = this.work;
    const doc = this.doc();
    if (work === null || doc === null) {
      return null;
    }
    return ticketPersonaOf(work.board as McBoard | null, doc.id, work.personas);
  });

  /** The thread face's chip persona: the board's pin, the current gate's as fallback. */
  protected readonly threadPersona = computed<{ title: string; color: string | null } | null>(() => {
    const pinned = this.questionPersona();
    if (pinned !== null) {
      return { title: pinned.title, color: pinned.color };
    }
    const gate = this.persona();
    return gate === null ? null : { title: this.personaTitle(gate), color: null };
  });

  /** The thread CTA: 'Answer <persona>'s question' or the ghost 'Open thread'. */
  protected readonly threadCta = computed<string | null>(() => {
    if (this.doc() === null) {
      return null;
    }
    const need = this.questionNeed();
    if (need === null) {
      return 'Open thread';
    }
    const persona = this.questionPersona()?.title ?? this.threadPersona()?.title ?? null;
    return persona === null ? 'Answer the question' : `Answer ${persona}'s question`;
  });

  // --- the thread face -------------------------------------------------------------

  /** The ticket's filtered view of the active chat session. */
  protected readonly threadItems = computed<readonly ThreadItem[]>(() => {
    const doc = this.doc();
    const active = this.chat?.chat().active ?? null;
    if (doc === null || active === null) {
      return [];
    }
    return threadItemsOf(doc.id, active.messages, active.proposals);
  });

  /** The thread composer's draft — prefilled with the `<id>:` context on open. */
  protected readonly threadDraft = signal('');
  protected readonly threadSending = signal(false);
  protected readonly threadError = signal<string | null>(null);

  protected onThreadDraft(event: Event): void {
    this.threadDraft.set((event.target as HTMLTextAreaElement).value);
  }

  protected onThreadKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey) {
      return;
    }
    event.preventDefault();
    void this.threadSend();
  }

  /**
   * The thread composer's send: into the ACTIVE session like the chat tab
   * (a fresh session when none is open). The streamed reply lands in the
   * session the thread filters, so the list grows on its own.
   */
  protected async threadSend(): Promise<void> {
    const chat = this.chat;
    const text = this.threadDraft().trim();
    if (chat === null || text === '' || this.threadSending() || this.readOnly()) {
      return;
    }
    this.threadError.set(null);
    this.threadSending.set(true);
    try {
      const reply = chat.chat().active === null ? await chat.newSession(text) : await chat.send(text);
      if (reply.ok) {
        this.threadDraft.set('');
      } else {
        this.threadError.set(reply.error);
      }
    } catch (err) {
      this.threadError.set(err instanceof Error && err.message.trim() !== '' ? err.message : 'Something went wrong — try again.');
    } finally {
      this.threadSending.set(false);
    }
  }

  // --- the thread face's option card ('Auswahl nie = Aktion') -----------------------

  protected readonly threadQSelected = signal<number | null>(null);
  protected readonly threadQPending = signal(false);
  protected readonly threadQDone = signal(false);
  protected readonly threadQError = signal<string | null>(null);

  /** The send row's dynamic label: `"<Option>" senden`. */
  protected threadQSendLabel(card: QuestionCardVm): string {
    const option = card.options[this.threadQSelected() ?? -1];
    return option === undefined ? 'Send answer' : `Send “${option.label}”`;
  }

  /** Marks the tapped option; nothing sends until the send row's button fires. */
  protected threadQSelect(index: number): void {
    if (this.readOnly() || this.threadQDone() || this.threadQPending()) {
      return;
    }
    this.threadQSelected.set(index);
  }

  /** The done line's persona label: the persona title, the ticket id as fallback. */
  protected readonly threadPersonaLabel = computed<string>(() => {
    const pinned = this.questionPersona()?.title;
    if (pinned !== undefined && pinned !== '') {
      return pinned;
    }
    const gate = this.persona();
    return gate === null ? this.id() : this.personaTitle(gate);
  });

  /** The one acting tap: the chosen option's answer goes to the run. */
  protected async threadQSend(): Promise<void> {
    const card = this.questionCard();
    const answer = this.work?.answer;
    const runId = card?.runId ?? null;
    const option = card === null ? undefined : card.options[this.threadQSelected() ?? -1];
    if (answer === undefined || runId === null || option === undefined) {
      return;
    }
    this.threadQPending.set(true);
    this.threadQError.set(null);
    try {
      const reply = await answer(runId, option.answerText);
      if (reply.ok) {
        this.threadQDone.set(true);
        this.work?.toast?.(`Answer sent — ${this.threadPersonaLabel()} keeps running`, 'ok');
      } else {
        this.threadQError.set(reply.error);
      }
    } catch {
      this.threadQError.set('The answer did not go through.');
    } finally {
      this.threadQPending.set(false);
    }
  }

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

  /**
   * The work tab's card back-swipe: when the state parks a send-back on
   * the open ticket, the screen lands straight on the proof face with
   * the Send-back panel open — the swipe's whole point. Opening consumes
   * the flag, so a dismissed panel stays dismissed; with the doc still
   * loading the effect waits for it (it re-runs when the doc lands).
   */
  private readonly openPendingSendBack = effect(() => {
    const doc = this.doc();
    if (this.vm.sendBackOpen?.() !== true || doc === null || this.readOnly()) {
      return;
    }
    this.mode.set('proof');
    this.sendBackOpen.set(true);
    this.note.set('');
    this.vm.dismissSendBack?.();
  });

  protected onNote(event: Event): void {
    this.note.set((event.target as HTMLTextAreaElement).value);
  }

  protected async sendBack(): Promise<void> {
    const note = this.note().trim();
    const comments = this.comments();
    if ((note === '' && comments.length === 0) || this.sendBackPending() || this.readOnly()) {
      return;
    }
    this.sendBackPending.set(true);
    this.result.set(null);
    try {
      const reply = await this.vm.sendBack(note, comments);
      if (reply.ok) {
        this.storeComments([]);
        this.cancelDraft();
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
   * 'Change by chat': the composer inherits the ticket context as the
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

  // --- shape mode (E10-3) ---------------------------------------------------------

  /** Shaping fits a ticket that has not reached the build queue yet; read-only devices never start one. */
  protected readonly canShape = computed(() => {
    const doc = this.doc();
    if (doc === null || this.readOnly() || this.vm.shape === undefined) {
      return false;
    }
    const at = doc.phases.findIndex((phase) => phase.id === doc.phase);
    const build = doc.phases.findIndex((phase) => phase.id === 'build');
    return at >= 0 && (build < 0 ? at <= 1 : at < build);
  });

  // --- the plan to approve (E10-4) ---------------------------------------------------

  /** How many parts the plan lists; the approval is offered from two on, on a ticket that is not finished. */
  protected readonly planParts = computed(() => {
    const doc = this.doc();
    if (doc === null || this.vm.approvePlan === undefined) {
      return 0;
    }
    const last = doc.phases[doc.phases.length - 1]?.id ?? null;
    return doc.phase === last ? 0 : planPartsOf(planSectionOf(doc.text)).length;
  });

  protected readonly canApprove = computed(() => this.planParts() >= 2);

  protected readonly canEditFlow = computed(() => this.vm.openFlow !== undefined && !this.readOnly());

  /** The gate sheet's first row: the flow editor, which edits the same chain with a preview. */
  protected openFlowEditor(): void {
    const doc = this.doc();
    if (doc !== null) {
      this.closeSheet();
      this.vm.openFlow?.(doc.id);
    }
  }

  protected approvePlan(): void {
    const doc = this.doc();
    if (doc !== null) {
      this.vm.approvePlan?.(doc.id);
    }
  }

  /** 'Shape with Paul': the chat opens on this ticket's shape session (or a fresh one). */
  protected shapeWithPaul(): void {
    const doc = this.doc();
    if (doc !== null) {
      this.vm.shape?.(doc.id);
    }
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

  // --- line comments (E11-3) -----------------------------------------------------

  /** Comments changed in this session, by ticket id; the rest read from storage. */
  private readonly commentEdits = signal<Readonly<Record<string, readonly ReviewComment[]>>>({});
  protected readonly comments = computed<readonly ReviewComment[]>(() => {
    const id = this.id();
    return this.commentEdits()[id] ?? this.loadComments(id);
  });
  /** The composer: a new comment (index null) or an edit of pending comment `index`. */
  protected readonly draft = signal<{ file: string; line: number; endLine: number | null; index: number | null } | null>(null);
  protected readonly draftText = signal('');

  protected readonly commentLabel = commentLabelOf;
  protected readonly sendBackLabel = computed(() => sendBackLabelOf(this.comments().length));

  private loadComments(id: string): readonly ReviewComment[] {
    try {
      const raw = localStorage.getItem(`mc.comments.${id}`);
      const parsed: unknown = raw === null ? [] : JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter(
            (c): c is ReviewComment =>
              typeof c === 'object' &&
              c !== null &&
              typeof (c as ReviewComment).file === 'string' &&
              typeof (c as ReviewComment).text === 'string' &&
              Number.isInteger((c as ReviewComment).line),
          )
        : [];
    } catch {
      return [];
    }
  }

  private storeComments(next: readonly ReviewComment[]): void {
    const id = this.id();
    this.commentEdits.update((edits) => ({ ...edits, [id]: next }));
    try {
      localStorage.setItem(`mc.comments.${id}`, JSON.stringify(next));
    } catch {
      // The comments live for this session only.
    }
  }

  /**
   * A tap on a changed-or-context line of the new file: the first tap
   * opens the composer there, a tap on another line of the same file
   * stretches the range from the first to it.
   */
  protected pickLine(file: TicketDiffFile, line: number | null): void {
    if (line === null || this.readOnly()) {
      return;
    }
    const open = this.draft();
    if (open === null || open.file !== file.path) {
      this.draft.set({ file: file.path, line, endLine: null, index: null });
      this.draftText.set('');
      return;
    }
    if (open.index !== null) {
      return; // an edit keeps the range it has
    }
    const first = Math.min(open.line, open.endLine ?? open.line, line);
    const last = Math.max(open.line, open.endLine ?? open.line, line);
    this.draft.set({ ...open, line: first, endLine: last > first ? last : null });
  }

  protected onDraftText(event: Event): void {
    this.draftText.set((event.target as HTMLTextAreaElement).value);
  }

  protected cancelDraft(): void {
    this.draft.set(null);
    this.draftText.set('');
  }

  protected addDraft(): void {
    const open = this.draft();
    const text = this.draftText().replace(/\s+/g, ' ').trim();
    if (open === null || text === '') {
      return;
    }
    const comment: ReviewComment = { file: open.file, line: open.line, endLine: open.endLine, text };
    const list = [...this.comments()];
    if (open.index === null) {
      list.push(comment);
    } else {
      list[open.index] = comment;
    }
    this.storeComments(list);
    this.cancelDraft();
  }

  protected editComment(index: number): void {
    const comment = this.comments()[index];
    if (comment === undefined) {
      return;
    }
    this.draft.set({ file: comment.file, line: comment.line, endLine: comment.endLine, index });
    this.draftText.set(comment.text);
  }

  protected deleteComment(index: number): void {
    this.storeComments(this.comments().filter((_, i) => i !== index));
    if (this.draft()?.index === index) {
      this.cancelDraft();
    }
  }

  /** Whether the composer sits under this line of this file (its last line). */
  protected draftAfter(path: string, newNo: number | null): boolean {
    const open = this.draft();
    return open !== null && newNo !== null && open.file === path && (open.endLine ?? open.line) === newNo;
  }

  /** The pending comments whose last line is this one (the composer replaces the one being edited). */
  protected commentsAfter(path: string, newNo: number | null): readonly { comment: ReviewComment; index: number }[] {
    if (newNo === null) {
      return [];
    }
    const editing = this.draft()?.index ?? null;
    return this.comments()
      .map((comment, index) => ({ comment, index }))
      .filter(({ comment, index }) => comment.file === path && (comment.endLine ?? comment.line) === newNo && index !== editing);
  }

  /** The tapped range is highlighted while the composer is open. */
  protected inDraft(path: string, newNo: number | null): boolean {
    const open = this.draft();
    return open !== null && newNo !== null && open.file === path && newNo >= open.line && newNo <= (open.endLine ?? open.line);
  }

  // --- diff review (E11-2): viewed marks, whole file, change n of m ------------

  /** Viewed marks changed in this session, by ticket id (`path#patch-hash` keys); the rest read from storage. */
  private readonly viewedEdits = signal<Readonly<Record<string, readonly string[]>>>({});
  private readonly viewed = computed<ReadonlySet<string>>(() => {
    const id = this.id();
    return new Set(this.viewedEdits()[id] ?? this.loadViewed(id));
  });
  /** Paths shown as the whole file instead of the changed lines. */
  protected readonly wholeFiles = signal<readonly string[]>([]);
  /** The current change run per path (0-based); absent = the first. */
  protected readonly changeAt = signal<Readonly<Record<string, number>>>({});

  private loadViewed(id: string): readonly string[] {
    try {
      const raw = localStorage.getItem(`mc.viewed.${id}`);
      const parsed: unknown = raw === null ? [] : JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
    } catch {
      return [];
    }
  }

  protected isViewed(file: TicketDiffFile): boolean {
    return this.viewed().has(viewedKeyOf(file.path, file.patch));
  }

  protected toggleViewed(file: TicketDiffFile): void {
    const next = new Set(this.viewed());
    const key = viewedKeyOf(file.path, file.patch);
    if (!next.delete(key)) {
      next.add(key);
    }
    const id = this.id();
    this.viewedEdits.update((edits) => ({ ...edits, [id]: [...next] }));
    try {
      localStorage.setItem(`mc.viewed.${id}`, JSON.stringify([...next]));
    } catch {
      // The mark lives for this session only.
    }
  }

  protected readonly viewedCount = computed(() => {
    const files = this.diff()?.files ?? [];
    return files.filter((file) => this.isViewed(file)).length;
  });

  protected isWhole(path: string): boolean {
    return this.wholeFiles().includes(path);
  }

  /** Whether the whole-file view is available at all (the adapter can fetch a file). */
  protected readonly canShowWhole = computed(() => this.vm.wholeFile !== undefined);

  protected setWhole(path: string, whole: boolean): void {
    const rest = this.wholeFiles().filter((known) => known !== path);
    this.wholeFiles.set(whole ? [...rest, path] : rest);
    this.changeAt.update((at) => ({ ...at, [path]: 0 }));
  }

  /** The rows a file shows: its changed lines, or — once fetched — the whole file with the patch laid over it. */
  protected rowsOf(file: TicketDiffFile): readonly ChangeRow[] {
    if (this.isWhole(file.path)) {
      const whole = this.vm.wholeFile?.(file.path) ?? null;
      if (whole !== null) {
        return changeRowsOf(wholeFileRowsOf(file.patch, whole.text));
      }
    }
    return changeRowsOf(patchRowsOf(file.patch));
  }

  /** True while the whole file was asked for and has not arrived. */
  protected loadingWhole(file: TicketDiffFile): boolean {
    return this.isWhole(file.path) && (this.vm.wholeFile?.(file.path) ?? null) === null;
  }

  protected wholeTruncated(file: TicketDiffFile): boolean {
    return this.isWhole(file.path) && (this.vm.wholeFile?.(file.path)?.truncated ?? false);
  }

  protected changeCount(file: TicketDiffFile): number {
    return changeCountOf(this.rowsOf(file));
  }

  protected changeIndex(file: TicketDiffFile): number {
    return Math.min(this.changeAt()[file.path] ?? 0, Math.max(this.changeCount(file) - 1, 0));
  }

  /**
   * Previous/next change: within the file first; past its last (first)
   * change the neighbouring file opens at its first (last) one.
   */
  protected stepChange(file: TicketDiffFile, direction: -1 | 1, host: HTMLElement): void {
    const files = this.diff()?.files ?? [];
    const count = this.changeCount(file);
    const target = this.changeIndex(file) + direction;
    let path = file.path;
    let index = target;
    if (target < 0 || target >= count) {
      const neighbour = files[files.findIndex((f) => f.path === file.path) + direction];
      if (neighbour === undefined) {
        return;
      }
      path = neighbour.path;
      const neighbourCount = this.changeCount(neighbour);
      index = direction === 1 ? 0 : Math.max(neighbourCount - 1, 0);
      this.touched.set(true);
      if (!this.expanded().includes(path)) {
        this.expanded.set([...this.expanded(), path]);
      }
    }
    this.changeAt.update((at) => ({ ...at, [path]: index }));
    // The row exists after this change detection pass.
    setTimeout(() => {
      const wanted = `${path}|${index}`;
      const row = [...host.querySelectorAll('[data-chg]')].find((el) => el.getAttribute('data-chg') === wanted);
      row?.scrollIntoView?.({ block: 'center' });
    });
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
