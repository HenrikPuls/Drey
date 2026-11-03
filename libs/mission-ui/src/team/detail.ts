import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  InjectionToken,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import type {
  ImprovementProposalView,
  PersonaImprovementsView,
  PersonaMemoryView,
  PersonaPatch,
  PersonaRouterView,
  PersonaThreadView,
} from '../api/dto';
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
  return content.replace(/\n+$/, '').split('\n').slice(0, CONTENT_PREVIEW_LINES).join('\n');
}

// --- the 1:1 chat's client-side intents (prototype convergence) -----------------

/**
 * What the owner's wording means to the persona chat, read client-side:
 * a create intent hands the text to Mission Control, a prompt intent
 * offers the prompt patch, a memory intent proposes a memory entry —
 * everything else is a plain message. Tolerance rule: every pattern is a
 * hint, never a throw.
 */
export type ChatIntent = 'ticket' | 'prompt' | 'memory' | 'plain';

/** "Neues Ticket: …" — the create intent the persona hands through. */
export const TICKET_INTENT_RE = /neues\s+ticket\s*:/i;

/** Coaching for the persona's own prompt.md. */
export const PROMPT_INTENT_RE = /prompt|regel|anweisung/i;

/** Coaching for the persona's memory. */
export const MEMORY_INTENT_RE = /merk dir|gedaechtnis|gedächtnis|memory/i;

/** The ticket intent wins (it hands through, nothing patches locally), then prompt, then memory. */
export function chatIntentOf(text: string): ChatIntent {
  if (TICKET_INTENT_RE.test(text)) {
    return 'ticket';
  }
  if (PROMPT_INTENT_RE.test(text)) {
    return 'prompt';
  }
  if (MEMORY_INTENT_RE.test(text)) {
    return 'memory';
  }
  return 'plain';
}

/** The snippet a proposal card shows — long wording clips at 90 characters. */
export const CARD_SNIPPET_CAP = 90;

export function snippetOf(text: string): string {
  return text.length > CARD_SNIPPET_CAP ? `${text.slice(0, CARD_SNIPPET_CAP)}…` : text;
}

/** The ` · HH:MM` stamp a message's who-line shows; '' when the stamp is unusable. */
export function timeWordsOf(at: string): string {
  if (at === '') {
    return '';
  }
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return ` · ${hh}:${mm}`;
}

// --- the setup tab's pure moves ---------------------------------------------------

/** The router cycle the setup row walks through, one PATCH per tap. */
export const ROUTER_CYCLE: readonly PersonaRouterView[] = ['off', 'budget', 'escalate-on-fail'];

export function nextRouterOf(current: PersonaRouterView): PersonaRouterView {
  const at = ROUTER_CYCLE.indexOf(current);
  return ROUTER_CYCLE[(at + 1) % ROUTER_CYCLE.length] ?? 'off';
}

/** The workers the setup sheet offers (the desk's harnesses). */
export const WORKER_OPTIONS: readonly string[] = ['claude-code', 'opencode'];

/** The skill list a toggle produces: the name dropped when carried, added when not. */
export function skillsToggled(skills: readonly string[], name: string): readonly string[] {
  return skills.includes(name) ? skills.filter((skill) => skill !== name) : [...skills, name];
}

/** The pool words the setup row shows ('opus · sonnet'); '' when the pool is empty. */
export function poolWordsOf(pool: readonly string[]): string {
  return pool.filter((model) => model.trim() !== '').join(' · ');
}

// --- the screen's contract -------------------------------------------------------

/** What Apply and Dismiss hand back (the desk's MutationResult slice). */
export interface DetailActionReply {
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * The persona's facts the tabs render. Beyond the directory slice the
 * setup tab consumes an optional tolerant slice (model, pool, skills,
 * router, worker) — an adapter that carries only the base facts keeps
 * every tab whole (the setup rows then show their dash).
 */
export interface PersonaFacts {
  readonly id: string;
  readonly title: string;
  readonly role: string;
  /** `#rrggbb`; the avatar ring's colour. */
  readonly color: string;
  /** The harness (`claude-code` | `opencode`); absent when the adapter omits it. */
  readonly worker?: string;
  /** The default model; absent when the adapter omits it. */
  readonly model?: string;
  /** The model pool (order = fallback); absent when the adapter omits it. */
  readonly pool?: readonly string[];
  /** The carried skill files; absent when the adapter omits them. */
  readonly skills?: readonly string[];
  /** The routing policy; absent reads as `off` (the cycle's start). */
  readonly router?: PersonaRouterView;
}

/** The persona detail's tabs. */
export type PersonaTab = 'chat' | 'improve' | 'mem' | 'setup';

/**
 * One coaching card the chat pane derived from the owner's wording:
 * a prompt patch or a memory proposal waits for the decision, the
 * ticket hint is informational only.
 */
export interface CoachingCardVm {
  readonly id: number;
  readonly kind: 'prompt' | 'memory' | 'ticket';
  /** The wording the card offers — the patch's text, the memory line, the handed-through text. */
  readonly text: string;
  /** The prompt/memory card's decision; null while it waits. */
  readonly decided: 'applied' | 'dismissed' | null;
}

/**
 * The persona detail's contract — the 1:1 grown four tabs (concept
 * §4.8, prototype #v-persona): Chat, 1:1 (the improvements), Memory and
 * Setup. The parent binds it over the api layer's persona slice; the
 * factory default is the closed, read-only state so the shell works
 * before wiring lands. Every member past the base eight is optional:
 * an adapter that lacks a tab's slice keeps that tab inert, never broken.
 */
export interface TeamDetailVm {
  /** The open persona's id; null = the detail is closed (it renders nothing). */
  open(): { id: string } | null;
  /** The persona's facts; null while unknown — the header falls back to the id. */
  persona(): PersonaFacts | null;
  /** The loaded improvements; null while the first fetch runs or it failed. */
  improvements(): PersonaImprovementsView | null;
  /** Why the load failed; null when all is well (the error state retries). */
  loadError(): string | null;
  /** Read-only paired devices watch but never act: every mutation hides. */
  readOnly(): boolean;
  /** Re-fetches the open persona's improvements (the error state's retry). */
  reload(): Promise<void>;
  /** The back arrow: the shell closes the detail. */
  close(): void;
  /** Applies the proposal — the desk rewrites its target in one commit. */
  apply(proposal: ImprovementProposalView): Promise<DetailActionReply>;
  /** Dismisses the proposal — the desk records the refusal. */
  dismiss(proposal: ImprovementProposalView): Promise<DetailActionReply>;
  /** The 1:1 thread; null while the first fetch runs. Absent = the thread stays empty. */
  thread?(): PersonaThreadView | null;
  /** Why the thread load failed; null when all is well. */
  threadError?(): string | null;
  /** Sends one owner line into the thread (the desk echoes and answers). */
  sendThread?(text: string): Promise<DetailActionReply>;
  /** The memory entries; null while the first fetch runs. Absent = the list stays empty. */
  memory?(): PersonaMemoryView | null;
  /** Why the memory load failed; null when all is well. */
  memoryError?(): string | null;
  /** Appends one manual memory entry. */
  addMemory?(text: string): Promise<DetailActionReply>;
  /** Pins or unpins the entry at `index` (the wire pins by position). */
  pinMemory?(index: number, pinned: boolean): Promise<DetailActionReply>;
  /** PATCH `/api/personas/<id>` — the setup tab's every change, one commit each. */
  patchPersona?(patch: PersonaPatch): Promise<DetailActionReply>;
  /** Hands the wording to Mission Control's chat composer (the create intent). */
  prefillChat?(text: string): void;
  /** A transient status note (the toast pill); absent = silent. */
  toast?(message: string, kind?: 'ok' | 'warn' | 'error'): void;
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
 * The persona detail — the 1:1 over four tabs (concept §4.8): Chat (the
 * coaching thread with the client-side prompt/memory/ticket intents and
 * their confirm cards), 1:1 (the friction proposals as cards with the
 * armed two-step Apply), Memory (the curated entries with pin toggles
 * and the manual add) and Setup (the mirror: model, pool, router,
 * worker, the prompt editor and the skill switches — every change one
 * PATCH, one commit). Read-only paired devices watch: their mutations
 * hide entirely.
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

  /** The open persona's id — the diffbox path and the commit words use it. */
  protected readonly openId = computed(() => this.vm.open()?.id ?? '');

  protected readonly readOnly = computed(() => this.vm.readOnly());

  protected readonly improvements = computed(() => this.vm.improvements());

  protected readonly loadError = computed(() => this.vm.loadError());

  // --- the tabs ----------------------------------------------------------------------

  protected readonly tab = signal<PersonaTab>('chat');

  protected setTab(tab: PersonaTab): void {
    this.tab.set(tab);
  }

  /** The 1:1 tab's badge: the open proposals; hidden at zero or while unknown. */
  protected readonly improveCount = computed(() => {
    const view = this.improvements();
    return view === null ? 0 : proposalsSplitOf(view).open.length;
  });

  /** The memory tab's badge: the entry count; hidden at zero or while unknown. */
  protected readonly memCount = computed(() => this.vm.memory?.()?.entries.length ?? 0);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.clearArmTimer());
    // A fresh 1:1 opens on the chat tab with every local draft and local
    // mirror cleared — even when it is the same persona again.
    effect(() => {
      if (this.vm.open() !== null) {
        this.tab.set('chat');
        this.cards.set([]);
        this.cardSeq.set(0);
        this.sendError.set(null);
        this.draft.set('');
        this.memDraft.set('');
        this.memError.set(null);
        this.pinBusy.set(null);
        this.pinError.set(null);
        this.routerLocal.set(null);
        this.skillsLocal.set(null);
        this.promptDraft.set('');
        this.promptError.set(null);
        this.setupBusy.set(null);
        this.setupError.set(null);
        this.sheet.set(null);
      }
    });
  }

  // --- the chat tab -------------------------------------------------------------------

  protected readonly thread = computed(() => this.vm.thread?.() ?? null);

  protected readonly threadError = computed(() => this.vm.threadError?.() ?? null);

  protected readonly draft = signal('');

  protected readonly sending = signal(false);

  /** The send's inline error; null when all is well. */
  protected readonly sendError = signal<string | null>(null);

  /** The coaching cards the chat derived, in send order. */
  protected readonly cards = signal<readonly CoachingCardVm[]>([]);

  private readonly cardSeq = signal(0);

  protected onDraftInput(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
  }

  protected readonly timeWordsOf = timeWordsOf;

  /**
   * Sends the composer's line: the optimistic echo lands at once (the
   * state layer appends), the client-side intents derive their cards —
   * the create intent hands through to Mission Control, a prompt or
   * memory intent waits for the decision — and the POST runs behind it.
   * A refusal lands inline; the pattern cards never throw.
   */
  protected async send(): Promise<void> {
    const text = this.draft().trim();
    if (text === '' || this.readOnly() || this.sending()) {
      return;
    }
    this.draft.set('');
    this.sendError.set(null);
    const intent = chatIntentOf(text);
    if (intent === 'ticket') {
      this.pushCard({ kind: 'ticket', text });
      this.vm.prefillChat?.(text);
    } else if (intent === 'prompt' || intent === 'memory') {
      this.pushCard({ kind: intent, text, decided: null });
    }
    this.sending.set(true);
    try {
      const reply = await this.vm.sendThread?.(text);
      if (reply !== undefined && !reply.ok) {
        this.sendError.set(reply.error ?? 'The message did not go through.');
      }
    } catch {
      this.sendError.set('The message did not go through.');
    } finally {
      this.sending.set(false);
    }
  }

  private pushCard(
    card: Omit<CoachingCardVm, 'id' | 'decided'> & {
      id?: number;
      decided?: CoachingCardVm['decided'];
    },
  ): void {
    const id = this.cardSeq() + 1;
    this.cardSeq.set(id);
    this.cards.update((known) => [
      ...known,
      { id, ...card, decided: card.decided ?? null } as CoachingCardVm,
    ]);
  }

  /** The card's offer text, clipped for the diffbox/preview line. */
  protected snippet(card: CoachingCardVm): string {
    return snippetOf(card.text);
  }

  /**
   * The prompt card's apply: PATCH `{prompt}` — one commit — then the
   * toast; the memory card's apply appends the entry. A refusal shows on
   * the card's own error line.
   */
  protected async applyCard(card: CoachingCardVm): Promise<void> {
    if (card.decided !== null) {
      return;
    }
    if (card.kind === 'prompt') {
      await this.runCardAction(card, { prompt: card.text }, 'Prompt updated (commit)');
    } else if (card.kind === 'memory') {
      await this.runCardAction(card, undefined, 'Memory entry added (commit)');
    }
  }

  /** The Verwerfen: the card folds, nothing was sent, nothing changed. */
  protected dismissCard(card: CoachingCardVm): void {
    if (card.decided !== null || card.kind === 'ticket') {
      return;
    }
    this.markCard(card.id, 'dismissed');
    this.vm.toast?.('Discarded — nothing changed', 'ok');
  }

  private async runCardAction(
    card: CoachingCardVm,
    patch: PersonaPatch | undefined,
    okToast: string,
  ): Promise<void> {
    try {
      const reply =
        patch !== undefined
          ? await this.vm.patchPersona?.(patch)
          : await this.vm.addMemory?.(card.text);
      if (reply === undefined || reply.ok) {
        this.markCard(card.id, 'applied');
        this.vm.toast?.(okToast, 'ok');
      } else {
        this.cardError.set({ id: card.id, text: reply.error ?? 'The change failed.' });
      }
    } catch {
      this.cardError.set({ id: card.id, text: 'The change failed.' });
    }
  }

  /** The last card action's inline error, keyed to its card; null when all is well. */
  protected readonly cardError = signal<{ id: number; text: string } | null>(null);

  protected errorForCard(card: CoachingCardVm): string | null {
    const error = this.cardError();
    return error !== null && error.id === card.id ? error.text : null;
  }

  private markCard(id: number, decided: 'applied' | 'dismissed'): void {
    this.cards.update((known) =>
      known.map((card) => (card.id === id ? { ...card, decided } : card)),
    );
  }

  // --- the 1:1 tab ----------------------------------------------------------------------

  /** True while the first fetch runs: the tab is open, the view empty, no error yet. */
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

  /** The .imp-src words: '<n> reports' (the Belege render as the mono lines below). */
  protected evidenceWords(proposal: ImprovementProposalView): string {
    const count = proposal.evidence.length;
    return `${count} ${count === 1 ? 'report' : 'reports'}`;
  }

  // --- the collapsible content previews -------------------------------------------

  protected readonly expanded = signal<readonly string[]>([]);

  protected isExpanded(id: string): boolean {
    return this.expanded().includes(id);
  }

  protected toggleExpanded(id: string): void {
    this.expanded.update((known) =>
      known.includes(id) ? known.filter((key) => key !== id) : [...known, id],
    );
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

  // --- the memory tab -----------------------------------------------------------------

  protected readonly memory = computed(() => this.vm.memory?.() ?? null);

  protected readonly memoryError = computed(() => this.vm.memoryError?.() ?? null);

  protected readonly memDraft = signal('');

  protected readonly memError = signal<string | null>(null);

  /** The entry index a pin toggle is in flight for; its button shows the busy state. */
  protected readonly pinBusy = signal<number | null>(null);

  protected readonly pinError = signal<string | null>(null);

  protected onMemDraftInput(event: Event): void {
    this.memDraft.set((event.target as HTMLTextAreaElement).value);
  }

  /** The '+' row's apply: appends the line as an unpinned entry. */
  protected async addMemory(): Promise<void> {
    const text = this.memDraft().trim();
    if (text === '' || this.readOnly()) {
      return;
    }
    this.memDraft.set('');
    this.memError.set(null);
    try {
      const reply = await this.vm.addMemory?.(text);
      if (reply !== undefined && !reply.ok) {
        this.memError.set(reply.error ?? 'The entry did not stick.');
      }
    } catch {
      this.memError.set('The entry did not stick.');
    }
  }

  /** The pin toggle: optimistic on the desk, one POST per tap, revert on refusal. */
  protected async togglePin(index: number, pinned: boolean): Promise<void> {
    if (this.readOnly() || this.pinBusy() !== null) {
      return;
    }
    this.pinBusy.set(index);
    this.pinError.set(null);
    try {
      const reply = await this.vm.pinMemory?.(index, !pinned);
      if (reply !== undefined && !reply.ok) {
        this.pinError.set(reply.error ?? 'The pin did not take.');
      }
    } catch {
      this.pinError.set('The pin did not take.');
    } finally {
      this.pinBusy.set(null);
    }
  }

  // --- the setup tab -------------------------------------------------------------------

  /** The local router mirror — the cycle keeps walking even when the desk never reports the policy back. */
  protected readonly routerLocal = signal<PersonaRouterView | null>(null);

  protected readonly routerValue = computed<PersonaRouterView>(
    () => this.routerLocal() ?? this.persona()?.router ?? 'off',
  );

  /** The local skills mirror — a toggle applies at once, the PATCH follows. */
  protected readonly skillsLocal = signal<readonly string[] | null>(null);

  protected readonly skillsValue = computed<readonly string[]>(
    () => this.skillsLocal() ?? this.persona()?.skills ?? [],
  );

  protected readonly promptDraft = signal('');

  protected readonly promptError = signal<string | null>(null);

  /** What a setup change is in flight for ('router' | 'model' | …); null = idle. */
  protected readonly setupBusy = signal<string | null>(null);

  protected readonly setupError = signal<string | null>(null);

  /** The open picker sheet; null = closed. */
  protected readonly sheet = signal<'model' | 'worker' | null>(null);

  /** The model options: the pool, falling back to the current model alone. */
  protected readonly modelOptions = computed(() => {
    const facts = this.persona();
    const pool = (facts?.pool ?? []).filter((model) => model.trim() !== '');
    if (pool.length > 0) {
      return pool;
    }
    const model = facts?.model?.trim() ?? '';
    return model === '' ? [] : [model];
  });

  /** The workers the setup sheet offers (the desk's harnesses). */
  protected readonly workerOptions = computed(() => WORKER_OPTIONS);

  /** The open sheet's options: the model pool, or the fixed worker list. */
  protected readonly sheetOptions = computed<readonly string[]>(() =>
    this.sheet() === 'worker' ? WORKER_OPTIONS : this.modelOptions(),
  );

  protected readonly poolWords = computed(() => poolWordsOf(this.persona()?.pool ?? []));

  protected skillOn(name: string): boolean {
    return this.skillsValue().includes(name);
  }

  protected onPromptInput(event: Event): void {
    this.promptDraft.set((event.target as HTMLTextAreaElement).value);
  }

  protected openSheet(which: 'model' | 'worker'): void {
    if (this.readOnly()) {
      return;
    }
    this.setupError.set(null);
    this.sheet.set(which);
  }

  protected closeSheet(): void {
    this.sheet.set(null);
  }

  /** The model/worker pick: one PATCH, one commit, the sheet folds. */
  protected async pick(kind: 'model' | 'worker', value: string): Promise<void> {
    if (this.readOnly() || this.setupBusy() !== null) {
      return;
    }
    this.sheet.set(null);
    await this.runSetup(kind, kind === 'model' ? { model: value } : { worker: value }, value);
  }

  /** The router row's tap: walk the cycle, PATCH the next policy. */
  protected async cycleRouter(): Promise<void> {
    if (this.readOnly() || this.setupBusy() !== null) {
      return;
    }
    const next = nextRouterOf(this.routerValue());
    this.routerLocal.set(next);
    await this.runSetup('router', { router: next }, next);
  }

  /** A skill switch: the local list flips at once, the new list PATCHes in one commit. */
  protected async toggleSkill(name: string): Promise<void> {
    if (this.readOnly() || this.setupBusy() !== null) {
      return;
    }
    const next = skillsToggled(this.skillsValue(), name);
    this.skillsLocal.set(next);
    await this.runSetup('skills', { skills: next }, name);
  }

  /** The prompt editor's save: an empty draft is refused silently (nothing to replace with). */
  protected async savePrompt(): Promise<void> {
    const text = this.promptDraft().trim();
    if (text === '' || this.readOnly() || this.setupBusy() !== null) {
      return;
    }
    this.promptError.set(null);
    this.setupBusy.set('prompt');
    this.setupError.set(null);
    try {
      const reply = await this.vm.patchPersona?.({ prompt: text });
      if (reply === undefined || reply.ok) {
        this.promptDraft.set('');
        this.vm.toast?.('Prompt updated (commit)', 'ok');
      } else {
        this.promptError.set(reply.error ?? 'The prompt did not save.');
      }
    } catch {
      this.promptError.set('The prompt did not save.');
    } finally {
      this.setupBusy.set(null);
    }
  }

  /** The pool row's tap: editing follows in a later milestone — the toast says so. */
  protected poolTap(): void {
    this.vm.toast?.('Pool editing — to come', 'ok');
  }

  /** One setup PATCH with the shared busy/error/toast handling. */
  private async runSetup(what: string, patch: PersonaPatch, named: string): Promise<void> {
    this.setupBusy.set(what);
    this.setupError.set(null);
    try {
      const reply = await this.vm.patchPersona?.(patch);
      if (reply === undefined || reply.ok) {
        this.vm.toast?.(`personas: ${this.openId()} ${what} → ${named} (commit)`, 'ok');
      } else {
        this.setupError.set(reply.error ?? 'The change did not save.');
        this.revertSetup(what);
      }
    } catch {
      this.setupError.set('The change did not save.');
      this.revertSetup(what);
    } finally {
      this.setupBusy.set(null);
    }
  }

  /** Folds a refused change's local mirror back onto the persona facts. */
  private revertSetup(what: string): void {
    if (what === 'router') {
      this.routerLocal.set(null);
    } else if (what === 'skills') {
      this.skillsLocal.set(null);
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
