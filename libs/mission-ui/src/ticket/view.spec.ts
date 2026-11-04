/**
 * The ticket screen's specs (E5c): the pure helpers — the gate-bar step
 * builder, the section splitter, the proof reader, the scout report
 * reader (E8), the Verlauf dress (canonical lines, the box, the gate
 * pills' per-phase costs, the totals), the armed two-step reducer, the
 * fullscreen font-size steps, the patch line kinds — then the component
 * class against a fake `TicketVm`, no DOM (the unit-test builder runs
 * these under jsdom, but nothing here renders a template). The raw
 * editor's own specs live in `edit.spec.ts`.
 */
import { signal, type Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ActiveSession, ChatStateView, McVerlaufEntry } from '../api/dto';
import { MC_CHAT_STATE, disconnectedChatState, type McChatState } from '../chat/chat.model';
import {
  MC_WORK_STATE,
  type McNeed,
  type McShapedQuestion,
  type McWorkState,
  type QuestionCardVm,
} from '../work/work.model';
import {
  ACCEPT_DISARMED,
  DEFAULT_DIFF_FONT_SIZE,
  MC_TICKET,
  acceptArmReduce,
  blockerNoteOf,
  chainPrefillOf,
  chainStepsOf,
  changeCountOf,
  changeRowsOf,
  diffFontSizeStep,
  gateCostOf,
  gateStepsOf,
  parseChainEntryView,
  patchLineKind,
  patchRowsOf,
  phaseTitleOf,
  proofOf,
  proofRecommendationOf,
  renderChainEntryView,
  renderChainEntryViews,
  scoutReportOf,
  splitTicketSections,
  threadItemsOf,
  usdLabelOf,
  verlaufBoxOf,
  verlaufCostsOf,
  verlaufLineOf,
  verlaufTotalOf,
  commentLabelOf,
  costTableOf,
  planChipOf,
  planStatusLineOf,
  estimateLineOf,
  sendBackLabelOf,
  tokenWordsOf,
  viewedKeyOf,
  wholeFileRowsOf,
  type GatePhase,
  type ProofReport,
  type ReviewComment,
  type ThreadItem,
  type ThreadMessage,
  type TicketActionReply,
  type TicketDiff,
  type TicketDiffFile,
  type TicketDoc,
  type TicketSaveReply,
  type TicketVm,
} from './ticket.model';
import { TicketView } from './view';

// --- fakes -----------------------------------------------------------------------

interface FakeTicket extends TicketVm {
  docValue: TicketDoc | null;
  editingValue: boolean;
  flashValue: string | null;
  errorValue: string | null;
  diffValue: TicketDiff | null;
  phaseColorValue: string | null;
  readOnlyValue: boolean;
  attachmentUrls: ReadonlyMap<string, string>;
  calls: { accept: number; sendBack: string[]; save: string[]; onClose: number; enterEdit: number; exitEdit: number; reload: number; proposeChain: string[]; prefillChat: string[] };
  acceptReply: TicketActionReply;
  sentComments: readonly ReviewComment[];
  sendBackReply: TicketActionReply;
  saveReply: TicketSaveReply;
}

function makeFake(patch: Partial<FakeTicket> = {}): FakeTicket {
  const fake = {
    docValue: null as TicketDoc | null,
    editingValue: false,
    flashValue: null as string | null,
    errorValue: null as string | null,
    diffValue: null as TicketDiff | null,
    phaseColorValue: null as string | null,
    readOnlyValue: false,
    attachmentUrls: new Map<string, string>(),
    calls: {
      accept: 0,
      sendBack: [] as string[],
      save: [] as string[],
      onClose: 0,
      enterEdit: 0,
      exitEdit: 0,
      reload: 0,
      proposeChain: [] as string[],
      prefillChat: [] as string[],
    },
    acceptReply: { ok: true } as TicketActionReply,
    sentComments: [] as readonly ReviewComment[],
    sendBackReply: { ok: true } as TicketActionReply,
    saveReply: { ok: true, revision: 'rev-2' } as TicketSaveReply,
    doc(): TicketDoc | null {
      return this.docValue;
    },
    editing(): boolean {
      return this.editingValue;
    },
    enterEdit(): void {
      this.calls.enterEdit += 1;
    },
    exitEdit(): void {
      this.calls.exitEdit += 1;
    },
    savedFlash(): string | null {
      return this.flashValue;
    },
    flashSaved(): void {
      this.flashValue = 'Saved — one commit on the desk.';
    },
    loadError(): string | null {
      return this.errorValue;
    },
    reload(): Promise<void> {
      this.calls.reload += 1;
      return Promise.resolve();
    },
    phaseColor(): string | null {
      return this.phaseColorValue;
    },
    diff(): TicketDiff | null {
      return this.diffValue;
    },
    readOnly(): boolean {
      return this.readOnlyValue;
    },
    attachmentUrl(name: string): string | null {
      return this.attachmentUrls.get(name) ?? null;
    },
    onClose(): void {
      this.calls.onClose += 1;
    },
    proposeChain(text: string): void {
      this.calls.proposeChain.push(text);
    },
    prefillChat(text: string): void {
      this.calls.prefillChat.push(text);
    },
    save(text: string): Promise<TicketSaveReply> {
      this.calls.save.push(text);
      return Promise.resolve(this.saveReply);
    },
    accept(): Promise<TicketActionReply> {
      this.calls.accept += 1;
      return Promise.resolve(this.acceptReply);
    },
    sendBack(note: string, comments?: readonly ReviewComment[]): Promise<TicketActionReply> {
      this.calls.sendBack.push(note);
      this.sentComments = comments ?? [];
      return Promise.resolve(this.sendBackReply);
    },
    ...patch,
  };
  return fake as unknown as FakeTicket;
}

const PHASES: GatePhase[] = [
  { id: 'build', title: 'Build', checkpoint: false },
  { id: 'verify', title: 'Verify', checkpoint: true },
  { id: 'done', title: 'Done', checkpoint: false },
];

const DOC: TicketDoc = {
  id: 'T-0042',
  title: 'Fix the palette race in CI',
  text: '',
  revision: 'rev-1',
  phase: 'verify',
  phases: PHASES,
  chain: [],
  priority: 'high',
  priorities: ['urgent', 'high', 'normal', 'low'],
  blocked: [],
  blockedBy: [],
  verlauf: [],
};

/** The Verlauf chapter's entries as the api layer parses them off FULL_TEXT. */
const FULL_VERLAUF: readonly McVerlaufEntry[] = [
  { phase: 'plan', persona: 'pia', model: 'opus', tokens: '12k', cost: 0.14, dauer: '12m', ausgang: 'handed-over' },
  { phase: 'verify', persona: 'tessa', model: 'sonnet', tokens: '52k', cost: 0.64, dauer: '40m', ausgang: 'proof' },
];

const FULL_TEXT = `---
id: T-0042
title: 'Fix the palette race in CI'
priority: high
---

## Description

What and why.

## Plan

How.

### Acceptance criteria

- [ ] \`npm run verify:unit\` — exits 0

## Verification

Tested on 2026-11-01T14:32:00Z by verify@engine — Electron 34.2.0 on win32.

### Criteria

- [x] \`npm run build\` → ![](../attachments/verify-20261101-143200-01.png)
- [ ] \`npm test\` — no screenshot: the app never became ready

### Findings

- The settings page stayed blank until the reload.

## Changes

**What changed for you:** The command palette opens once.

## Handover

State: done

## Verlauf

\`\`\`yaml
- {phase: plan, persona: pia, model: opus, tokens: 12k, cost: 0.14, ausgang: handed-over}
- {phase: verify, persona: tessa, model: sonnet, tokens: 52k, cost: 0.64, ausgang: proof}
\`\`\`

## Log

- '2026-10-17T14:32:00Z' owner — created in inbox

## Result

It works.
`;

const FULL_DOC: TicketDoc = { ...DOC, text: FULL_TEXT, verlauf: FULL_VERLAUF };

const SCOUT_TEXT = `---
id: T-0043
title: 'Which storage backs the index?'
form: scout
---

## Description

Read the repo, the history and the data; recommend a storage.

## Report

Written on 2026-11-02T14:32:00Z by pia.

### Summary

The repo carries two index implementations; only SQLite is wired into the build.

### Decisions

- [ ] D1: Which storage should back the index? — Recommendation: SQLite, the repo already ships the helper.
- [x] D2: Migrate existing data? — Recommendation: yes, one migration script.

## Log

- '2026-11-02T14:00:00Z' pia — scouted the index question
`;

const SCOUT_DOC: TicketDoc = { ...DOC, id: 'T-0043', title: 'Which storage backs the index?', text: SCOUT_TEXT };

// The template-facing surface is protected; these specs drive the class
// directly, so expose it through one typed lens.
interface TicketSurface {
  isEmpty(): boolean;
  id(): string;
  title(): string;
  phaseTitle(): string;
  mode(): 'ticket' | 'proof' | 'thread';
  persona(): string | null;
  personaTitle(persona: string): string;
  cost(): string | null;
  costTotal(): string | null;
  fmLine(): string;
  readOnly(): boolean;
  steps(): ReturnType<typeof gateStepsOf>;
  bodyText(): string;
  proof(): ReturnType<typeof proofOf> | null;
  report(): ReturnType<typeof scoutReportOf> | null;
  verlauf(): string | null;
  verdict(): { passed: number; total: number; stamp: string } | null;
  shots(): readonly { name: string; url: string }[];
  diff(): unknown;
  planState(): { line: string | null; marks: readonly unknown[] } | null;
  comments(): readonly ReviewComment[];
  draft(): { file: string; line: number; endLine: number | null; index: number | null } | null;
  draftText(): string;
  sendBackLabel(): string;
  pickLine(file: TicketDiffFile, line: number | null): void;
  onDraftText(event: Event): void;
  addDraft(): void;
  cancelDraft(): void;
  editComment(index: number): void;
  deleteComment(index: number): void;
  draftAfter(path: string, newNo: number | null): boolean;
  commentsAfter(path: string, newNo: number | null): readonly { comment: ReviewComment; index: number }[];
  inDraft(path: string, newNo: number | null): boolean;
  viewedCount(): number;
  isViewed(file: TicketDiffFile): boolean;
  toggleViewed(file: TicketDiffFile): void;
  canShowWhole(): boolean;
  setWhole(path: string, whole: boolean): void;
  isWhole(path: string): boolean;
  loadingWhole(file: TicketDiffFile): boolean;
  rowsOf(file: TicketDiffFile): readonly unknown[];
  changeCount(file: TicketDiffFile): number;
  changeIndex(file: TicketDiffFile): number;
  stepChange(file: TicketDiffFile, direction: -1 | 1, host: HTMLElement): void;
  result(): { kind: 'error' | 'note'; text: string } | null;
  savedFlash(): string | null;
  arm(): { armed: boolean; since: number };
  acceptPending(): boolean;
  accepted(): boolean;
  acceptTap(): void;
  sendBackOpen(): boolean;
  note(): string;
  sendBackPending(): boolean;
  onNote(event: Event): void;
  toggleSendBack(): void;
  sendBack(): Promise<void>;
  editing(): boolean;
  toggleEdit(): void;
  changeByChat(): void;
  galIndex(): number;
  onGalScroll(gal: HTMLElement): void;
  galTo(index: number, gal: HTMLElement): void;
  expanded(): readonly string[];
  isExpanded(path: string): boolean;
  toggleExpanded(path: string): void;
  fullscreen(): unknown;
  openFullscreen(file: unknown, event: Event): void;
  closeFullscreen(): void;
  fontSize(): number;
  stepFont(direction: -1 | 1): void;
  viewer(): unknown;
  openViewer(shot: unknown): void;
  closeViewer(): void;
}

function surface(view: TicketView): TicketSurface {
  return view as unknown as TicketSurface;
}

function setup(fake: TicketVm | null): TicketView {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: fake === null ? [] : [{ provide: MC_TICKET, useValue: fake }],
  });
  return TestBed.runInInjectionContext(() => new TicketView());
}

function noteEvent(value: string): Event {
  return { target: { value } } as unknown as Event;
}

/** An event carrying stopPropagation, for overlay-open taps that must not bubble. */
function tapEvent(): Event {
  const event = noteEvent('');
  event.stopPropagation = () => undefined;
  return event;
}

// --- the gate bar ------------------------------------------------------------------

describe('gateStepsOf', () => {
  const phases: GatePhase[] = [
    { id: 'inbox', title: 'Inbox', checkpoint: false },
    { id: 'build', title: 'Build', checkpoint: false },
    { id: 'verify', title: 'Verify', checkpoint: true },
    { id: 'done', title: 'Done', checkpoint: false },
  ];

  it('accents the current phase and dims the future ones', () => {
    expect(gateStepsOf(phases, 'verify').map((step) => step.state)).toEqual([
      'past',
      'past',
      'current',
      'future',
    ]);
  });

  it('marks checkpoints and keeps their titles', () => {
    const steps = gateStepsOf(phases, 'inbox');
    expect(steps.map((step) => step.checkpoint)).toEqual([false, false, true, false]);
    expect(steps[2]?.title).toBe('Verify');
  });

  it('returns an empty strip for no phases', () => {
    expect(gateStepsOf([], 'verify')).toEqual([]);
  });

  it('dims everything when the ticket sits in a phase the pipeline does not know', () => {
    expect(gateStepsOf(phases, 'limbo').every((step) => step.state === 'future')).toBe(true);
  });
});

// --- the chain delta (E9, concept §5.7) ------------------------------------------------

describe('parseChainEntryView', () => {
  it('reads the three grammar shapes and never guesses', () => {
    expect(parseChainEntryView('skip verify')).toEqual({
      kind: 'skip',
      phase: 'verify',
      anchor: null,
      position: null,
      persona: null,
      notify: false,
    });
    expect(parseChainEntryView('notify build')).toEqual({
      kind: 'notify',
      phase: 'build',
      anchor: null,
      position: null,
      persona: null,
      notify: false,
    });
    expect(parseChainEntryView('insert design(pia, notify) after review')).toEqual({
      kind: 'insert',
      phase: 'design',
      anchor: 'review',
      position: 'after',
      persona: 'pia',
      notify: true,
    });
  });

  it('refuses anything the grammar does not hold', () => {
    expect(parseChainEntryView('')).toBeNull();
    expect(parseChainEntryView('skip Verify')).toBeNull();
    expect(parseChainEntryView('insert design after')).toBeNull();
    expect(parseChainEntryView('insert design(nope!) after review')).toBeNull();
    expect(parseChainEntryView('insert design(pia, extra, notify) after review')).toBeNull();
    expect(parseChainEntryView('delete verify')).toBeNull();
  });
});

describe('renderChainEntryView', () => {
  it('round-trips what the parser reads', () => {
    const texts = [
      'skip verify',
      'notify build',
      'insert design after review',
      'insert design(pia, notify) before review',
    ];
    for (const text of texts) {
      const entry = parseChainEntryView(text);
      expect(entry).not.toBeNull();
      expect(renderChainEntryView(entry!)).toBe(text);
    }
    expect(renderChainEntryViews(texts.map((text) => parseChainEntryView(text)!))).toEqual(texts);
  });
});

describe('chainStepsOf', () => {
  const phases: GatePhase[] = [
    { id: 'inbox', title: 'Inbox', checkpoint: false },
    { id: 'build', title: 'Build', checkpoint: false },
    { id: 'verify', title: 'Verify', checkpoint: true },
    { id: 'done', title: 'Done', checkpoint: false },
  ];

  it('renders the standard flow untouched when the delta is empty', () => {
    expect(chainStepsOf(phases, 'build', [])).toEqual(gateStepsOf(phases, 'build'));
  });

  it('strikes a skipped gate and raises the notify flag', () => {
    const entries = [
      parseChainEntryView('skip verify')!,
      parseChainEntryView('notify build')!,
    ];
    const steps = chainStepsOf(phases, 'build', entries);
    expect(steps.find((step) => step.id === 'verify')?.skipped).toBe(true);
    expect(steps.find((step) => step.id === 'build')?.notify).toBe(true);
  });

  it('splices an inserted gate after its anchor, persona and notify riding along', () => {
    const entries = [parseChainEntryView('insert design(pia, notify) after verify')!];
    const steps = chainStepsOf(phases, 'verify', entries);
    const at = steps.findIndex((step) => step.id === 'design');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(steps[at! - 1]?.id).toBe('verify');
    expect(steps[at!]).toMatchObject({ inserted: true, persona: 'pia', notify: true, title: 'design' });
  });

  it('tolerates an unknown anchor by appending and an unknown phase by id-title', () => {
    const entries = [parseChainEntryView('insert design after limbo')!];
    const steps = chainStepsOf(phases, 'inbox', entries);
    expect(steps[steps.length - 1]).toMatchObject({ id: 'design', title: 'design', inserted: true });
  });
});

describe('chainPrefillOf', () => {
  it('words the standard-flow return like the card summary', () => {
    expect(chainPrefillOf('T-0042', [])).toBe('Return T-0042 to the standard flow');
  });

  it('carries the entries behind one colon', () => {
    expect(chainPrefillOf('T-0042', ['skip verify'])).toBe('Set T-0042 chain: skip verify');
    expect(chainPrefillOf('T-0042', ['insert design(pia, notify) after review', 'skip verify'])).toBe(
      'Set T-0042 chain: insert design(pia, notify) after review; skip verify',
    );
  });
});

// --- the gate sheet (E9, concept §5.7) ------------------------------------------------

describe('TicketView gate sheet', () => {
  interface SheetSurface {
    sheetOpen(): boolean;
    hasDelta(): boolean;
    insertPhase(): string;
    insertAnchor(): string;
    insertDisabled(): boolean;
    notifyGate(): string;
    notifyDisabled(): boolean;
    openSheet(): void;
    closeSheet(): void;
    onInsertPhase(event: Event): void;
    onInsertAnchor(event: Event): void;
    onInsertNotify(event: Event): void;
    onNotifyGate(event: Event): void;
    prefillInsert(): void;
    prefillNotify(): void;
    prefillStandard(): void;
  }

  const sheet = (view: TicketView): SheetSurface => view as unknown as SheetSurface;

  function checkedEvent(checked: boolean): Event {
    return { target: { checked } } as unknown as Event;
  }

  it('opens with the current gate as anchor and notify pick', () => {
    const fake = makeFake({ docValue: DOC });
    const vm = sheet(setup(fake));
    vm.openSheet();
    expect(vm.sheetOpen()).toBe(true);
    expect(vm.insertAnchor()).toBe('verify');
    expect(vm.notifyGate()).toBe('verify');
    expect(vm.hasDelta()).toBe(false);
  });

  it('prefills the chat with the delta plus the insert entry and closes', () => {
    const fake = makeFake({ docValue: DOC });
    const vm = sheet(setup(fake));
    vm.openSheet();
    vm.onInsertPhase(noteEvent('design'));
    vm.onInsertNotify(checkedEvent(true));
    vm.prefillInsert();
    expect(vm.sheetOpen()).toBe(false);
    expect(fake.calls.proposeChain).toEqual(['Set T-0042 chain: insert design(notify) after verify']);
  });

  it('keeps the entries the ticket already holds when inserting', () => {
    const doc: TicketDoc = { ...DOC, chain: [parseChainEntryView('skip done')!] };
    const fake = makeFake({ docValue: doc });
    const vm = sheet(setup(fake));
    vm.openSheet();
    vm.onInsertPhase(noteEvent('design'));
    vm.prefillInsert();
    expect(fake.calls.proposeChain).toEqual(['Set T-0042 chain: skip done; insert design after verify']);
    expect(vm.hasDelta()).toBe(true);
  });

  it('refuses the insert while phase and anchor match and when it adds nothing new', () => {
    const fake = makeFake({ docValue: DOC });
    const vm = sheet(setup(fake));
    vm.openSheet();
    vm.onInsertPhase(noteEvent('verify'));
    expect(vm.insertDisabled()).toBe(true);
    vm.onInsertPhase(noteEvent('design'));
    expect(vm.insertDisabled()).toBe(false);
    vm.prefillInsert();
    // The same entry twice: the second run sees it in the delta and disables.
    const again = sheet(setup(makeFake({ docValue: { ...DOC, chain: [parseChainEntryView('insert design after verify')!] } })));
    again.openSheet();
    again.onInsertPhase(noteEvent('design'));
    expect(again.insertDisabled()).toBe(true);
  });

  it('prefills the notify rule for the picked gate and disables gates that already ring', () => {
    const doc: TicketDoc = { ...DOC, chain: [parseChainEntryView('notify build')!] };
    const fake = makeFake({ docValue: doc });
    const vm = sheet(setup(fake));
    vm.openSheet();
    expect(vm.notifyDisabled()).toBe(false); // verify rings nothing yet
    vm.onNotifyGate(noteEvent('build'));
    expect(vm.notifyDisabled()).toBe(true);
    vm.onNotifyGate(noteEvent('done'));
    expect(vm.notifyDisabled()).toBe(false);
    vm.prefillNotify();
    expect(fake.calls.proposeChain).toEqual(['Set T-0042 chain: notify build; notify done']);
  });

  it('prefills the standard-flow return with an empty delta', () => {
    const doc: TicketDoc = { ...DOC, chain: [parseChainEntryView('skip done')!] };
    const fake = makeFake({ docValue: doc });
    const vm = sheet(setup(fake));
    vm.openSheet();
    vm.prefillStandard();
    expect(vm.sheetOpen()).toBe(false);
    expect(fake.calls.proposeChain).toEqual(['Return T-0042 to the standard flow']);
  });

  it('offers the flow editor from the sheet when the adapter has one, and hands the ticket over', () => {
    const opened: string[] = [];
    const fake = { ...makeFake({ docValue: DOC }), openFlow: (id: string) => opened.push(id) };
    const view = setup(fake);
    const vm = sheet(view);
    vm.openSheet();
    const surface = view as unknown as { canEditFlow(): boolean; openFlowEditor(): void };
    expect(surface.canEditFlow()).toBe(true);
    surface.openFlowEditor();
    expect(opened).toEqual(['T-0042']);
    expect(vm.sheetOpen()).toBe(false);
    const without = setup(makeFake({ docValue: DOC })) as unknown as { canEditFlow(): boolean };
    expect(without.canEditFlow()).toBe(false);
  });

  it('opens nothing without a document', () => {
    const fake = makeFake({ docValue: null });
    const vm = sheet(setup(fake));
    vm.openSheet();
    expect(vm.sheetOpen()).toBe(false);
  });
});

describe('phaseTitleOf', () => {
  it('resolves the current phase title and falls back to the raw id', () => {
    expect(phaseTitleOf(PHASES, 'verify')).toBe('Verify');
    expect(phaseTitleOf(PHASES, 'limbo')).toBe('limbo');
    expect(phaseTitleOf([], 'verify')).toBe('verify');
  });
});

// --- the section splitter ------------------------------------------------------------

describe('splitTicketSections', () => {
  it('pulls Verification, Changes, Handover, Verlauf and Log out of the generic render', () => {
    const sections = splitTicketSections(FULL_TEXT);
    expect(sections.body).toContain('## Description');
    expect(sections.body).toContain('### Acceptance criteria');
    expect(sections.body).toContain('## Result');
    expect(sections.body).not.toContain('Tested on');
    expect(sections.body).not.toContain('created in inbox');
    expect(sections.body).not.toContain('ausgang');
    expect(sections.verification).toContain('Tested on 2026-11-01T14:32:00Z');
    expect(sections.verification).not.toContain('## Verification');
    expect(sections.changes).toBe('**What changed for you:** The command palette opens once.');
    expect(sections.handover).toBe('State: done');
    expect(sections.verlauf).toContain('{phase: plan, persona: pia');
    expect(sections.verlauf).toContain('ausgang: proof');
    expect(sections.verlauf).toContain('```yaml');
    expect(sections.verlauf).not.toContain('## Verlauf');
    expect(sections.log).toContain("'2026-10-17T14:32:00Z' owner — created in inbox");
  });

  it('never lets the frontmatter reach the render', () => {
    const sections = splitTicketSections(FULL_TEXT);
    expect(sections.body).not.toContain('id: T-0042');
    expect(sections.body.startsWith('## Description')).toBe(true);
  });

  it('matches the special titles case-insensitively and H3 headings ride inside', () => {
    const sections = splitTicketSections(
      '## verification\n\n- [x] `a`\n\n### Criteria\n\nx\n\n## LOG\n\n- line\n\n## VERLAUF\n\n- {a: 1}',
    );
    expect(sections.verification).toContain('### Criteria');
    expect(sections.log).toBe('- line');
    expect(sections.verlauf).toBe('- {a: 1}');
  });

  it('reports absent sections as null and an all-generic file whole in the body', () => {
    const sections = splitTicketSections('## Description\n\nOnly this.\n');
    expect(sections.verification).toBeNull();
    expect(sections.report).toBeNull();
    expect(sections.changes).toBeNull();
    expect(sections.handover).toBeNull();
    expect(sections.log).toBeNull();
    expect(sections.verlauf).toBeNull();
    expect(sections.body).toBe('## Description\n\nOnly this.');
  });

  it('treats a similar-but-not-exact heading as body', () => {
    const sections = splitTicketSections('## Verification notes\n\nStays.');
    expect(sections.verification).toBeNull();
    expect(sections.body).toContain('## Verification notes');
  });

  it('pulls the Report out of the generic render (E8)', () => {
    const sections = splitTicketSections(SCOUT_TEXT);
    expect(sections.report).toContain('Written on 2026-11-02T14:32:00Z by pia.');
    expect(sections.report).toContain('### Decisions');
    expect(sections.report).not.toContain('## Report');
    expect(sections.body).toContain('## Description');
    expect(sections.body).not.toContain('Written on');
    expect(sections.body).not.toContain('D1: Which storage');
    expect(sections.log).toContain('scouted the index question');
  });
});

// --- the verlauf box -----------------------------------------------------------------

describe('the Verlauf dress', () => {
  const entry: McVerlaufEntry = {
    phase: 'plan',
    persona: 'pia',
    model: 'opus',
    tokens: '48k',
    cost: 1.17,
    dauer: '12m',
    ausgang: 'handed-over',
  };

  it('renders one canonical line per entry — all seven keys, nulls for the lost ones', () => {
    expect(verlaufLineOf(entry)).toBe(
      '- { phase: plan, persona: pia, model: opus, tokens: 48k, cost: 1.17, dauer: 12m, ausgang: handed-over }',
    );
    const torn = { ...entry, phase: null, model: null, tokens: '', cost: null, dauer: '', ausgang: null };
    expect(verlaufLineOf(torn)).toBe(
      '- { phase: null, persona: pia, model: null, tokens: null, cost: null, dauer: null, ausgang: null }',
    );
  });

  it('boxes the entries one per line, and hides the box when nothing remains', () => {
    expect(verlaufBoxOf([entry, { ...entry, phase: 'build' }])).toBe(
      '- { phase: plan, persona: pia, model: opus, tokens: 48k, cost: 1.17, dauer: 12m, ausgang: handed-over }\n'
        + '- { phase: build, persona: pia, model: opus, tokens: 48k, cost: 1.17, dauer: 12m, ausgang: handed-over }',
    );
    expect(verlaufBoxOf([])).toBeNull();
  });

  it('sums the entries’ costs per phase, lowercased; phase-less and cost-less lines skip', () => {
    const costs = verlaufCostsOf([
      entry, // plan → 1.17
      { ...entry, phase: 'Plan', cost: 0.23 }, // the same phase, case-insensitive → 1.40
      { ...entry, phase: 'build', cost: null }, // an unknown cost never counts as 0
      { ...entry, phase: null }, // no phase to hang the cost on
      { ...entry, phase: 'build', cost: 0.4 }, // build → 0.40
    ]);
    expect(costs.get('plan')).toBeCloseTo(1.4, 10);
    expect(costs.get('build')).toBeCloseTo(0.4, 10);
    expect(costs.size).toBe(2);
  });

  it('reads the gate pill’s figure off the phase — by id first, then by title', () => {
    const costs = verlaufCostsOf([
      { ...entry, phase: 'build', cost: 0.24 },
      { ...entry, phase: 'Verify', cost: 0.64 },
    ]);
    expect(gateCostOf(costs, { id: 'build', title: 'Build' })).toBe('0.24');
    expect(gateCostOf(costs, { id: 'verify', title: 'Verify' })).toBe('0.64');
    // The title fallback: a hand-written chapter may carry the display title.
    expect(gateCostOf(costs, { id: 'check', title: 'Verify' })).toBe('0.64');
    expect(gateCostOf(costs, { id: 'done', title: 'Done' })).toBeNull();
  });

  it('labels the dollars and totals the chapter — never a 0-fake', () => {
    expect(usdLabelOf(1.87)).toBe('$1.87');
    expect(usdLabelOf(0.42)).toBe('$0.42');
    expect(usdLabelOf(12)).toBe('$12.00');
    expect(usdLabelOf(0)).toBeNull();
    expect(usdLabelOf(null)).toBeNull();
    expect(usdLabelOf(undefined)).toBeNull();
    expect(usdLabelOf(Number.NaN)).toBeNull();
    expect(usdLabelOf(-1)).toBeNull();
    expect(verlaufTotalOf([entry, { ...entry, cost: 0.7 }])).toBe('$1.87');
    expect(verlaufTotalOf([{ ...entry, cost: null }, { ...entry, cost: 0 }])).toBeNull();
    expect(verlaufTotalOf([])).toBeNull();
  });
});

// --- the proof reader ------------------------------------------------------------------

describe('proofOf', () => {
  it('reads the stamp, the tester, the criteria with screenshots and notes, and the findings', () => {
    const verification = splitTicketSections(FULL_TEXT).verification!;
    const proof = proofOf(verification);
    expect(proof.testedOn).toBe(
      'Tested on 2026-11-01T14:32:00Z by verify@engine — Electron 34.2.0 on win32.',
    );
    expect(proof.tester).toBe('verify@engine');
    expect(proof.criteria).toEqual([
      { command: 'npm run build', passed: true, screenshot: 'verify-20261101-143200-01.png', note: null },
      { command: 'npm test', passed: false, screenshot: null, note: 'no screenshot: the app never became ready' },
    ]);
    expect(proof.findings).toEqual(['The settings page stayed blank until the reload.']);
  });

  it('degrades honestly on half-readable sections', () => {
    expect(proofOf('')).toEqual({ testedOn: '', tester: '', criteria: [], findings: [], video: null, videoNotKept: null, chapters: [] });
    const loose = proofOf('- [x] checked by hand\n- [ ] `npm run build`\ngarbage line');
    expect(loose.criteria).toEqual([
      { command: 'checked by hand', passed: true, screenshot: null, note: null },
      { command: 'npm run build', passed: false, screenshot: null, note: null },
    ]);
    expect(loose.findings).toEqual([]);
  });

  it('reads the walkthrough video with its chapters, or the removal note (E11-1)', () => {
    const withVideo = proofOf(
      '### Criteria\n\n- [x] `a`\n\n### Video\n\n![](../videos/verify-1-T-0001.webm)\n\n- 0:03 a\n- 1:05 b\n\n### Findings\n\n- one',
    );
    expect(withVideo.video).toBe('verify-1-T-0001.webm');
    expect(withVideo.chapters).toEqual([
      { atSec: 3, label: 'a' },
      { atSec: 65, label: 'b' },
    ]);
    expect(withVideo.criteria).toHaveLength(1);
    expect(withVideo.findings).toEqual(['one']);
    const removed = proofOf('### Criteria\n\n- [x] `a`\n\n### Video\n\nVideo not kept: 31.2 MB exceeds the 25 MB limit.\n');
    expect(removed.video).toBeNull();
    expect(removed.videoNotKept).toBe('Video not kept: 31.2 MB exceeds the 25 MB limit.');
    // A tests proof carries neither: nothing for the card to show.
    const tests = proofOf('### Criteria\n\n- [x] `a` — checked by the machine gate\n');
    expect(tests.video).toBeNull();
    expect(tests.videoNotKept).toBeNull();
  });

  it('collects every bullet under Findings and ignores prose lines', () => {
    const proof = proofOf(
      '### Criteria\n\n- [x] `a`\n\n### Findings\n\n- one\nprose without a bullet\n- two',
    );
    expect(proof.criteria).toHaveLength(1);
    expect(proof.findings).toEqual(['one', 'two']);
  });
});

// --- the scout report reader (E8) ------------------------------------------------------

describe('scoutReportOf', () => {
  it('reads the stamp, the summary and the decisions with their recommendations', () => {
    const report = scoutReportOf(splitTicketSections(SCOUT_TEXT).report!);
    expect(report).toEqual({
      writtenAt: '2026-11-02T14:32:00Z',
      by: 'pia',
      summary: 'The repo carries two index implementations; only SQLite is wired into the build.',
      decisions: [
        {
          key: 'D1',
          question: 'Which storage should back the index?',
          recommendation: 'SQLite, the repo already ships the helper.',
          resolved: false,
        },
        { key: 'D2', question: 'Migrate existing data?', recommendation: 'yes, one migration script.', resolved: true },
      ],
    });
  });

  it('degrades honestly on half-readable sections', () => {
    expect(scoutReportOf('')).toEqual({ writtenAt: '', by: '', summary: '', decisions: [] });
    const loose = scoutReportOf(
      'Written by nobody.\n\n### Decisions\n\n- [x] not a decision line\n- [ ] D1: Only a question?\n- [x] D9: Both — Recommendation: ship it',
    );
    expect(loose.writtenAt).toBe('');
    expect(loose.by).toBe('');
    expect(loose.summary).toBe('');
    expect(loose.decisions).toEqual([
      { key: 'D1', question: 'Only a question?', recommendation: null, resolved: false },
      { key: 'D9', question: 'Both', recommendation: 'ship it', resolved: true },
    ]);
  });

  it('stops the summary at the Decisions head and keeps a recommendation-less decision', () => {
    const report = scoutReportOf('### Summary\n\nFirst line.\nMore.\n\n### Decisions\n\n- [ ] D1: Bare?');
    expect(report.summary).toBe('First line.\nMore.');
    expect(report.decisions).toEqual([{ key: 'D1', question: 'Bare?', recommendation: null, resolved: false }]);
  });
});

// --- the armed two-step ------------------------------------------------------------------

describe('acceptArmReduce', () => {
  it('arms on the first tap and executes on the second inside the window', () => {
    const first = acceptArmReduce(ACCEPT_DISARMED, { kind: 'tap', now: 1000 });
    expect(first.execute).toBe(false);
    expect(first.state).toEqual({ armed: true, since: 1000 });

    const second = acceptArmReduce(first.state, { kind: 'tap', now: 2500 });
    expect(second.execute).toBe(true);
    expect(second.state).toEqual(ACCEPT_DISARMED);
  });

  it('re-arms instead of executing when the window has lapsed', () => {
    const armed = { armed: true, since: 1000 };
    const late = acceptArmReduce(armed, { kind: 'tap', now: 1000 + 4000 });
    expect(late.execute).toBe(false);
    expect(late.state).toEqual({ armed: true, since: 5000 });
  });

  it('a tick past the window disarms, inside it leaves the arm standing', () => {
    const armed = { armed: true, since: 1000 };
    expect(acceptArmReduce(armed, { kind: 'tick', now: 4999 }).state).toEqual(armed);
    expect(acceptArmReduce(armed, { kind: 'tick', now: 5000 }).state).toEqual(ACCEPT_DISARMED);
  });

  it('never executes on a tick', () => {
    expect(acceptArmReduce(ACCEPT_DISARMED, { kind: 'tick', now: 10_000 }).execute).toBe(false);
  });
});

// --- the fullscreen font size --------------------------------------------------------------

describe('diffFontSizeStep', () => {
  it('steps up and down the size list', () => {
    expect(diffFontSizeStep(13, 1)).toBe(14);
    expect(diffFontSizeStep(13, -1)).toBe(12);
  });

  it('clamps at both ends', () => {
    expect(diffFontSizeStep(24, 1)).toBe(24);
    expect(diffFontSizeStep(11, -1)).toBe(11);
  });

  it('starts from the default when the current size is off the list', () => {
    expect(diffFontSizeStep(19, 1)).toBe(14);
    expect(diffFontSizeStep(19, -1)).toBe(12);
    expect(DEFAULT_DIFF_FONT_SIZE).toBe(13);
  });
});

// --- the patch line kinds --------------------------------------------------------------------

describe('patchLineKind', () => {
  it('colours added, removed, meta and context lines', () => {
    expect(patchLineKind('+added')).toBe('add');
    expect(patchLineKind('-removed')).toBe('del');
    expect(patchLineKind('@@ -1,3 +1,4 @@')).toBe('meta');
    expect(patchLineKind('+++ b/src/app.ts')).toBe('meta');
    expect(patchLineKind('--- a/src/app.ts')).toBe('meta');
    expect(patchLineKind('diff --git a/x b/x')).toBe('meta');
    expect(patchLineKind(' context')).toBe('context');
  });
});

describe('patchRowsOf', () => {
  it('numbers the rows off the hunk heads and signs added and removed', () => {
    const rows = patchRowsOf(
      [
        'diff --git a/a.ts b/a.ts',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -12,3 +12,3 @@',
        ' context',
        '-gone',
        '+here',
        '\\ No newline at end of file',
      ].join('\n'),
    );
    expect(rows).toEqual([
      { kind: 'meta', oldNo: null, newNo: null, sign: '', text: 'diff --git a/a.ts b/a.ts' },
      { kind: 'meta', oldNo: null, newNo: null, sign: '', text: '--- a/a.ts' },
      { kind: 'meta', oldNo: null, newNo: null, sign: '', text: '+++ b/a.ts' },
      { kind: 'hunk', oldNo: null, newNo: null, sign: '', text: '@@ -12,3 +12,3 @@' },
      { kind: 'context', oldNo: 12, newNo: 12, sign: '', text: 'context' },
      { kind: 'del', oldNo: 13, newNo: null, sign: '−', text: 'gone' },
      { kind: 'add', oldNo: null, newNo: 13, sign: '+', text: 'here' },
      { kind: 'meta', oldNo: null, newNo: null, sign: '', text: '\\ No newline at end of file' },
    ]);
  });

  it('renders no rows for an empty patch and starts at 1 without a hunk head', () => {
    expect(patchRowsOf('')).toEqual([]);
    expect(patchRowsOf('+first\n context')).toEqual([
      { kind: 'add', oldNo: null, newNo: 1, sign: '+', text: 'first' },
      { kind: 'context', oldNo: 1, newNo: 2, sign: '', text: 'context' },
    ]);
  });

  it('re-seeds the counters at every hunk', () => {
    const rows = patchRowsOf('@@ -1 +1 @@\n-a\n+b\n@@ -40,2 +42,2 @@\n c');
    expect(rows[1]).toMatchObject({ kind: 'del', oldNo: 1, newNo: null });
    expect(rows[2]).toMatchObject({ kind: 'add', oldNo: null, newNo: 1 });
    expect(rows[4]).toMatchObject({ kind: 'context', oldNo: 40, newNo: 42 });
  });
});

// --- the priority chip and the blocker line --------------------------------------

describe('blockerNoteOf', () => {
  it('warns on open blockers, reads declared deps neutral, and stays silent on none', () => {
    expect(blockerNoteOf(['T-0001', 'T-0003'], ['T-0001'])).toEqual({ kind: 'blocked', ids: ['T-0001', 'T-0003'] });
    expect(blockerNoteOf([], ['T-0007'])).toEqual({ kind: 'depends', ids: ['T-0007'] });
    expect(blockerNoteOf([], [])).toBeNull();
  });
});

describe('TicketView head card', () => {
  it('reads the persona off the current gate and raises it for display', () => {
    const doc: TicketDoc = {
      ...DOC,
      phase: 'design',
      chain: [parseChainEntryView('insert design(pia) after build')!],
    };
    const vm = surface(setup(makeFake({ docValue: doc })));
    expect(vm.persona()).toBe('pia');
    expect(vm.personaTitle('pia')).toBe('Pia');
    expect(vm.fmLine()).toBe('phase: design · persona: pia');
  });

  it('stays silent without a persona: the chip and the fm slot drop out', () => {
    const vm = surface(setup(makeFake({ docValue: DOC })));
    expect(vm.persona()).toBeNull();
    expect(vm.fmLine()).toBe('phase: verify');
  });

  it('keeps the cost slots empty while the doc carries no usage and no Verlauf costs', () => {
    const vm = surface(setup(makeFake({ docValue: DOC })));
    expect(vm.cost()).toBeNull();
    expect(vm.costTotal()).toBeNull();
    // The merged chain ships the cost slot on every step, null until filled.
    expect(vm.steps().every((step) => step.cost === null)).toBe(true);
    // No readable entries — the Verlauf box stays hidden too.
    expect(vm.verlauf()).toBeNull();
  });

  it('wears the ledger’s usage on the head card and the Verlauf costs on the gates', () => {
    const doc: TicketDoc = {
      ...FULL_DOC,
      usage: { tokensIn: 48000, tokensOut: 6000, cost: 0.42, runs: 2 },
    };
    const vm = surface(setup(makeFake({ docValue: doc })));
    // The head slot reads the usage figure; the bar's end slot sums the chapter.
    expect(vm.cost()).toBe('$0.42');
    expect(vm.costTotal()).toBe('$0.78');
    // build sits in the past, verify is current: their pills carry their phase's sum.
    const [build, verify, done] = vm.steps();
    expect(build!.cost).toBeNull(); // the chapter starts at plan — no build entries yet
    expect(verify!.cost).toBe('0.64');
    expect(done!.cost).toBeNull();
  });

  it('matches a gate’s Verlauf costs by title when the phase id misses', () => {
    const doc: TicketDoc = {
      ...DOC,
      verlauf: [
        { phase: 'Build', persona: 'ben', model: 'glm-5.3', tokens: '121k', cost: 0.61, dauer: '41m', ausgang: 'failed' },
        { phase: 'review', persona: 'ralf', model: 'opus', tokens: '9k', cost: 0.38, dauer: '8m', ausgang: 'handed-over' },
      ],
    };
    const vm = surface(setup(makeFake({ docValue: doc })));
    const [build] = vm.steps();
    expect(build!.cost).toBe('0.61'); // entry.phase 'Build' matches the step's title, not its id
    // The total sums every entry, the phase-less review included.
    expect(vm.costTotal()).toBe('$0.99');
  });
});

// --- the component class ------------------------------------------------------------------------

describe('TicketView', () => {
  it('renders the empty state against the factory default', () => {
    const vm = surface(setup(null));
    expect(vm.isEmpty()).toBe(true);
    expect(vm.id()).toBe('');
    expect(vm.title()).toBe('');
    expect(vm.steps()).toEqual([]);
    expect(vm.proof()).toBeNull();
    expect(vm.report()).toBeNull();
    expect(vm.verlauf()).toBeNull();
    expect(vm.verdict()).toBeNull();
    expect(vm.savedFlash()).toBeNull();
  });

  it('derives the header, the steps, the body blocks, the proof and the verlauf from the bound doc', () => {
    const vm = surface(setup(makeFake({ docValue: FULL_DOC })));
    expect(vm.isEmpty()).toBe(false);
    expect(vm.id()).toBe('T-0042');
    expect(vm.title()).toBe('Fix the palette race in CI');
    expect(vm.phaseTitle()).toBe('Verify');
    expect(vm.steps().map((step) => step.state)).toEqual(['past', 'current', 'future']);
    const headings = vm.bodyText().split('\n').filter((line) => /^#{1,6} /.test(line));
    expect(headings.map((line) => line.replace(/^#{1,6} /, ''))).toEqual([
      'Description',
      'Plan',
      'Acceptance criteria',
      'Result',
    ]);
    expect(vm.proof()?.criteria).toHaveLength(2);
    expect(vm.proof()?.findings).toEqual(['The settings page stayed blank until the reload.']);
    // The Verlauf chapter left the body and lands one canonical line per entry.
    expect(vm.verlauf()).toBe(
      '- { phase: plan, persona: pia, model: opus, tokens: 12k, cost: 0.14, dauer: 12m, ausgang: handed-over }\n'
        + '- { phase: verify, persona: tessa, model: sonnet, tokens: 52k, cost: 0.64, dauer: 40m, ausgang: proof }',
    );
    // The chapter's costs dress the bar's end slot too.
    expect(vm.costTotal()).toBe('$0.78');
    expect(vm.verdict()).toEqual({
      passed: 1,
      total: 2,
      stamp: 'Tested on 2026-11-01T14:32:00Z by verify@engine — Electron 34.2.0 on win32.',
    });
  });

  it('falls back to the id when the title is blank and to the phase id off the pipeline', () => {
    const vm = surface(
      setup(makeFake({ docValue: { ...DOC, title: '  ', phase: 'limbo' } })),
    );
    expect(vm.title()).toBe('T-0042');
    expect(vm.phaseTitle()).toBe('limbo');
  });

  it('resolves no shots when the vm cannot serve attachments', () => {
    const vm = surface(setup(makeFake({ docValue: FULL_DOC })));
    expect(vm.shots()).toEqual([]);
  });

  it('renders no scout report on a ticket without the chapter', () => {
    const vm = surface(setup(makeFake({ docValue: FULL_DOC })));
    expect(vm.report()).toBeNull();
  });

  it('derives the scout report card from the Report chapter (E8)', () => {
    const vm = surface(setup(makeFake({ docValue: SCOUT_DOC })));
    const report = vm.report();
    expect(report?.writtenAt).toBe('2026-11-02T14:32:00Z');
    expect(report?.by).toBe('pia');
    expect(report?.summary).toBe('The repo carries two index implementations; only SQLite is wired into the build.');
    expect(report?.decisions).toEqual([
      {
        key: 'D1',
        question: 'Which storage should back the index?',
        recommendation: 'SQLite, the repo already ships the helper.',
        resolved: false,
      },
      { key: 'D2', question: 'Migrate existing data?', recommendation: 'yes, one migration script.', resolved: true },
    ]);
    // The chapter left the generic body; the Log never reaches it either way.
    const headings = vm.bodyText().split('\n').filter((line) => /^#{1,6} /.test(line));
    expect(headings.map((line) => line.replace(/^#{1,6} /, ''))).toEqual(['Description']);
  });

  it('resolves the screenshots the vm serves and opens the viewer', () => {
    const fake = makeFake({ docValue: FULL_DOC });
    fake.attachmentUrls = new Map([
      ['verify-20261101-143200-01.png', '/api/attachments/verify-20261101-143200-01.png'],
    ]);
    const vm = surface(setup(fake));
    const shots = vm.shots();
    expect(shots).toEqual([
      { name: 'verify-20261101-143200-01.png', url: '/api/attachments/verify-20261101-143200-01.png' },
    ]);
    vm.openViewer(shots[0]);
    expect(vm.viewer()).toEqual(shots[0]);
    vm.closeViewer();
    expect(vm.viewer()).toBeNull();
  });

  it('arms Accept on the first tap and executes on the second', async () => {
    const fake = makeFake({ docValue: FULL_DOC });
    const vm = surface(setup(fake));

    vm.acceptTap();
    expect(vm.arm().armed).toBe(true);
    expect(fake.calls.accept).toBe(0);

    vm.acceptTap();
    expect(fake.calls.accept).toBe(1);
    expect(vm.arm().armed).toBe(false);

    await Promise.resolve();
    expect(vm.result()).toEqual({ kind: 'note', text: 'Accepted.' });
  });

  it('shows the accept refusal inline and surfaces a warning as the note', async () => {
    const refusing = makeFake({ docValue: FULL_DOC, acceptReply: { ok: false, error: 'the gate is red' } });
    const vm = surface(setup(refusing));
    vm.acceptTap();
    vm.acceptTap();
    await Promise.resolve();
    expect(vm.result()).toEqual({ kind: 'error', text: 'the gate is red' });

    const warning = makeFake({
      docValue: FULL_DOC,
      acceptReply: { ok: true, warning: 'The worktree has uncommitted changes and was kept' },
    });
    const vm2 = surface(setup(warning));
    vm2.acceptTap();
    vm2.acceptTap();
    await Promise.resolve();
    expect(vm2.result()).toEqual({
      kind: 'note',
      text: 'The worktree has uncommitted changes and was kept',
    });
  });

  it('never accepts on a read-only device', async () => {
    const fake = makeFake({ docValue: FULL_DOC, readOnlyValue: true });
    const vm = surface(setup(fake));
    vm.acceptTap();
    vm.acceptTap();
    await Promise.resolve();
    expect(fake.calls.accept).toBe(0);
    expect(vm.arm().armed).toBe(false);
  });

  it('sends back only with a non-empty note and closes the panel on success', async () => {
    const fake = makeFake({ docValue: FULL_DOC });
    const vm = surface(setup(fake));

    vm.toggleSendBack();
    expect(vm.sendBackOpen()).toBe(true);
    await vm.sendBack();
    expect(fake.calls.sendBack).toEqual([]);

    vm.onNote(noteEvent('   '));
    await vm.sendBack();
    expect(fake.calls.sendBack).toEqual([]);

    vm.onNote(noteEvent(' The button still misaligns '));
    await vm.sendBack();
    expect(fake.calls.sendBack).toEqual(['The button still misaligns']);
    expect(vm.sendBackOpen()).toBe(false);
    expect(vm.note()).toBe('');
    expect(vm.result()).toEqual({ kind: 'note', text: 'Sent back.' });
  });

  it('keeps the send-back panel open and shows the error on a refusal', async () => {
    const fake = makeFake({
      docValue: FULL_DOC,
      sendBackReply: { ok: false, error: 'no agent phase to send back to' },
    });
    const vm = surface(setup(fake));
    vm.toggleSendBack();
    vm.onNote(noteEvent('wrong color'));
    await vm.sendBack();
    expect(vm.sendBackOpen()).toBe(true);
    expect(vm.result()).toEqual({ kind: 'error', text: 'no agent phase to send back to' });
  });

  // --- the parked send-back (the work tab's card back-swipe) --------------------

  it('the parked send-back lands on the proof face with the panel open, once', () => {
    let dismissed = 0;
    // Real signals feed the vm reads — the consumption must behave like
    // the app's state (a plain-function fake would leave the effect
    // dependence-free and its flushes undetermined).
    const parked = signal(true);
    const fake = makeFake({
      docValue: FULL_DOC,
      sendBackOpen: () => parked(),
      dismissSendBack: () => {
        dismissed += 1;
        parked.set(false);
      },
    });
    const vm = surface(setup(fake));
    TestBed.flushEffects();

    expect(vm.mode()).toBe('proof');
    expect(vm.sendBackOpen()).toBe(true);
    expect(vm.note()).toBe('');
    expect(dismissed).toBe(1);

    TestBed.flushEffects();
    expect(vm.sendBackOpen()).toBe(true); // the panel stays open (local state)
    expect(dismissed).toBe(1); // consumed exactly once — no re-arm
  });

  it('a parked send-back waits for the doc; the panel opens when it lands', () => {
    let dismissed = 0;
    const docValue = signal<TicketDoc | null>(null);
    const parked = signal(true);
    const fake = makeFake({
      sendBackOpen: () => parked(),
      dismissSendBack: () => {
        dismissed += 1;
        parked.set(false);
      },
    });
    fake.doc = () => docValue();
    const vm = surface(setup(fake));
    TestBed.flushEffects();
    expect(vm.sendBackOpen()).toBe(false);
    expect(dismissed).toBe(0);

    docValue.set(FULL_DOC);
    TestBed.flushEffects();
    expect(vm.mode()).toBe('proof');
    expect(vm.sendBackOpen()).toBe(true);
    expect(dismissed).toBe(1);
  });

  it('a view-only vm without the sendBackOpen input never auto-opens', () => {
    const fake = makeFake({ docValue: FULL_DOC });
    const vm = surface(setup(fake));
    TestBed.flushEffects();
    expect(vm.sendBackOpen()).toBe(false);
    expect(vm.mode()).toBe('ticket');
  });

  it('dismissing the auto-opened panel keeps it closed — the flag was consumed', () => {
    let dismissed = 0;
    const parked = signal(true);
    const fake = makeFake({
      docValue: FULL_DOC,
      sendBackOpen: () => parked(),
      dismissSendBack: () => {
        dismissed += 1;
        parked.set(false);
      },
    });
    const vm = surface(setup(fake));
    TestBed.flushEffects();
    expect(vm.sendBackOpen()).toBe(true);

    vm.toggleSendBack(); // the panel's Cancel
    expect(vm.sendBackOpen()).toBe(false);

    TestBed.flushEffects();
    expect(vm.sendBackOpen()).toBe(false);
    expect(dismissed).toBe(1);
  });

  it('hands the raw file to the editor: enter on the toggle, exit when it is open', () => {
    const fake = makeFake({ docValue: FULL_DOC });
    const vm = surface(setup(fake));

    vm.toggleEdit();
    expect(fake.calls.enterEdit).toBe(1);
    expect(fake.calls.exitEdit).toBe(0);

    fake.editingValue = true;
    vm.toggleEdit();
    expect(fake.calls.exitEdit).toBe(1);
  });

  it('never edits on a read-only device', () => {
    const fake = makeFake({ docValue: FULL_DOC, readOnlyValue: true });
    const vm = surface(setup(fake));
    vm.toggleEdit();
    expect(fake.calls.enterEdit).toBe(0);
    expect(fake.calls.exitEdit).toBe(0);
  });

  it('shows the editor’s save flash without closing anything', () => {
    const fake = makeFake({ docValue: FULL_DOC });
    fake.flashSaved();
    const vm = surface(setup(fake));
    expect(vm.savedFlash()).toBe('Saved — one commit on the desk.');
    expect(vm.isEmpty()).toBe(false);
  });

  it('opens the first diff file by default and then follows the taps', () => {
    const diff = {
      files: [
        {
          status: 'M',
          path: 'src/a.ts',
          patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new',
          added: 1,
          removed: 1,
        },
        { status: 'A', path: 'src/b.ts', patch: 'new file', added: 5, removed: null },
      ],
      truncated: true,
    };
    const fake = makeFake({ docValue: DOC, diffValue: diff });
    const vm = surface(setup(fake));
    expect(vm.diff()).toEqual(diff);

    // The prototype's first-open: file one starts expanded, the rest closed.
    expect(vm.isExpanded('src/a.ts')).toBe(true);
    expect(vm.isExpanded('src/b.ts')).toBe(false);

    // The first tap retires the implicit seed and owns the state from there.
    vm.toggleExpanded('src/a.ts');
    expect(vm.isExpanded('src/a.ts')).toBe(false);
    expect(vm.isExpanded('src/b.ts')).toBe(false);
    vm.toggleExpanded('src/b.ts');
    expect(vm.isExpanded('src/b.ts')).toBe(true);
    expect(vm.isExpanded('src/a.ts')).toBe(false);

    vm.openFullscreen(diff.files[0], tapEvent());
    expect(vm.fullscreen()).toEqual(diff.files[0]);
    expect(vm.fontSize()).toBe(13);
    vm.stepFont(1);
    vm.stepFont(1);
    expect(vm.fontSize()).toBe(15);
    vm.closeFullscreen();
    expect(vm.fullscreen()).toBeNull();
    expect(vm.fontSize()).toBe(15);
  });

  it('prefills the chat with the ticket context through the vm prefill path', () => {
    const fake = makeFake({ docValue: DOC });
    const vm = surface(setup(fake));
    vm.changeByChat();
    expect(fake.calls.prefillChat).toEqual(['T-0042: ']);
    expect(fake.calls.proposeChain).toEqual([]);
  });

  it('falls back to the chain prefill path while the vm ships no prefillChat', () => {
    const fake = makeFake({ docValue: DOC, prefillChat: undefined });
    const vm = surface(setup(fake));
    vm.changeByChat();
    expect(fake.calls.proposeChain).toEqual(['T-0042: ']);
  });

  it('swaps the actions for the mint done ring once the accept lands', async () => {
    const fake = makeFake({ docValue: FULL_DOC });
    const vm = surface(setup(fake));
    expect(vm.accepted()).toBe(false);

    vm.acceptTap();
    vm.acceptTap();
    await Promise.resolve();
    expect(fake.calls.accept).toBe(1);
    expect(vm.accepted()).toBe(true);
    expect(vm.result()).toEqual({ kind: 'note', text: 'Accepted.' });

    const refusing = makeFake({ docValue: FULL_DOC, acceptReply: { ok: false, error: 'the gate is red' } });
    const vm2 = surface(setup(refusing));
    vm2.acceptTap();
    vm2.acceptTap();
    await Promise.resolve();
    expect(vm2.accepted()).toBe(false);
    expect(vm2.result()).toEqual({ kind: 'error', text: 'the gate is red' });
  });

  it('syncs the gallery dots with the scroll position and taps back', () => {
    const galleryText = `---
id: T-0044
title: 'Three shots'
---

## Verification

- [x] \`one\` → ![](../attachments/s1.png)
- [x] \`two\` → ![](../attachments/s2.png)
- [x] \`three\` → ![](../attachments/s3.png)
`;
    const fake = makeFake({
      docValue: { ...DOC, id: 'T-0044', text: galleryText },
    });
    fake.attachmentUrls = new Map([
      ['s1.png', '/api/attachments/s1.png'],
      ['s2.png', '/api/attachments/s2.png'],
      ['s3.png', '/api/attachments/s3.png'],
    ]);
    const vm = surface(setup(fake));
    expect(vm.shots()).toHaveLength(3);
    const gal = {
      scrollLeft: 0,
      scrollWidth: 900,
      clientWidth: 300,
      scrollTo: () => undefined,
    } as unknown as HTMLElement;
    vm.onGalScroll(gal);
    expect(vm.galIndex()).toBe(0);

    const wide = { ...gal, scrollLeft: 640 } as unknown as HTMLElement;
    vm.onGalScroll(wide);
    expect(vm.galIndex()).toBe(2);

    vm.galTo(1, gal);
    expect(vm.galIndex()).toBe(1);
  });
});

// --- the proof verdict's recommendation ----------------------------------------------

describe('proofRecommendationOf', () => {
  const report = (tester: string): ProofReport => ({
    testedOn: tester === '' ? '' : `Tested on 2026-11-01T14:32:00Z by ${tester} — Electron 34.2.0`,
    tester,
    criteria: [{ command: 'npm test', passed: true, screenshot: null, note: null }],
    findings: [],
    video: null,
    videoNotKept: null,
    chapters: [],
  });

  it('names the tester with its first letter raised', () => {
    expect(proofRecommendationOf(report('tessa'))).toBe('Tessa recommends accepting.');
  });

  it('stays silent when the stamp names no tester', () => {
    expect(proofRecommendationOf(report(''))).toBeNull();
  });
});

// --- the thread's filtered view of the active session ----------------------------------

describe('threadItemsOf', () => {
  const message = (text: string, at = '2026-11-02T09:12:00Z'): ThreadMessage => ({
    role: 'owner',
    text,
    thought: null,
    at,
  });
  const proposal = (id: string, summary: string, state = 'pending', commandId = 'T-0091'): unknown => ({
    id,
    state,
    summary,
    at: '2026-11-02T09:14:00Z',
    command: { kind: 'setChain', id: commandId, chain: [] },
  });

  it('keeps the messages whose text names the ticket and drops the rest', () => {
    const items = threadItemsOf('T-0091', [message('T-0091: what next?'), message('unrelated')], []);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind === 'message' && items[0]!.message.text).toBe('T-0091: what next?');
  });

  it('keeps the proposal cards whose command names the ticket (tolerantly serialized)', () => {
    const items = threadItemsOf(
      'T-0091',
      [message('hi')],
      [proposal('p-1', 'Set T-0091 chain: skip verify'), proposal('p-2', 'Move T-0077 to build', 'confirmed', 'T-0077')],
    );
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.kind).toBe('proposal');
    if (item.kind === 'proposal') {
      expect(item.proposal.id).toBe('p-1');
    }
  });

  it('interleaves stamped items by their ISO stamps; unstamped ones keep file order', () => {
    const stamped = threadItemsOf('T-0091', [message('T-0091 first', '2026-11-02T09:20:00Z')], [
      proposal('p-1', 'Set T-0091 chain'),
    ]);
    expect(stamped.map((item) => item.kind)).toEqual(['proposal', 'message']);

    const unstamped = threadItemsOf('T-0091', [message('T-0091 first', '')], [
      { id: 'p-1', state: 'pending', summary: 'Set T-0091 chain' },
    ]);
    expect(unstamped.map((item) => item.kind)).toEqual(['message', 'proposal']);
  });

  it('an empty id never matches; an unreadable proposal drops', () => {
    expect(threadItemsOf('', [message('T-0091')], [])).toEqual([]);
    expect(threadItemsOf('T-0091', [], ['junk', null, { summary: 'T-0091 without an id' }])).toEqual([]);
  });
});

// --- the three faces: ticket, proof, thread ---------------------------------------------

describe('TicketView faces', () => {
  function chatState(messages: readonly ThreadMessage[], proposals: readonly unknown[] = []): McChatState {
    return {
      ...disconnectedChatState(),
      chat: signal<ChatStateView>({
        sessions: [],
        active: {
          file: 's.md',
          title: 'S',
          createdAt: '',
          messages,
          proposals: proposals as ActiveSession['proposals'],
        },
      }),
      send: () => Promise.resolve({ ok: true }),
      newSession: () => Promise.resolve({ ok: true }),
    };
  }

  function workState(patch: Partial<McWorkState> = {}): McWorkState {
    return {
      needs: patch.needs ?? [],
      board: patch.board ?? null,
      personas: patch.personas ?? [],
      readOnly: patch.readOnly ?? false,
      moveTicket: () => Promise.resolve({ ok: true }),
      answer: patch.answer,
      toast: patch.toast,
    };
  }

  const ASKING_NEED: McNeed = {
    kind: 'question',
    ticketId: 'T-0042',
    title: 'Ask',
    summary: 'Which way?',
    runId: 'r-1',
    shaped: cardQuestionShaped(),
  };

  interface FaceSurface extends TicketSurface {
    mode(): 'ticket' | 'proof' | 'thread';
    openProof(): void;
    openThread(): void;
    backToTicket(): void;
    proofCta(): string | null;
    proofRecommendation(): string | null;
    threadCta(): string | null;
    questionNeed(): McNeed | null;
    questionCard(): QuestionCardVm | null;
    threadPersona(): { title: string; color: string | null } | null;
    threadPersonaLabel(): string;
    threadItems(): readonly ThreadItem[];
    threadDraft(): string;
    onThreadDraft(event: Event): void;
    threadSend(): Promise<void>;
    threadError(): string | null;
    threadQSelected(): number | null;
    threadQDone(): boolean;
    threadQError(): string | null;
    threadQSendLabel(card: QuestionCardVm): string;
    threadQSelect(index: number): void;
    threadQSend(): Promise<void>;
  }

  function setupFaces(
    fake: TicketVm,
    patch: { chat?: McChatState | null; work?: McWorkState | null } = {},
  ): FaceSurface {
    TestBed.resetTestingModule();
    const providers: Provider[] = [{ provide: MC_TICKET, useValue: fake }];
    if (patch.chat !== null) {
      providers.push({ provide: MC_CHAT_STATE, useValue: patch.chat ?? chatState([]) });
    }
    if (patch.work !== null) {
      providers.push({ provide: MC_WORK_STATE, useValue: patch.work ?? workState() });
    }
    TestBed.configureTestingModule({ providers });
    return TestBed.runInInjectionContext(() => new TicketView()) as unknown as FaceSurface;
  }

  const PROOF_TEXT = `## Verification\n\nTested on 2026-11-01T14:32:00Z by tessa — Electron 34.2.0.\n\n### Criteria\n\n- [x] \`npm run build\` → ![](../attachments/verify-01.png)\n- [x] \`npm test\` — exits 0\n`;

  it('a fresh ticket starts on its ticket face; the proof CTA names the count, the verdict the tester', () => {
    const vm = setupFaces(makeFake({ docValue: { ...FULL_DOC, text: PROOF_TEXT } }));
    expect(vm.mode()).toBe('ticket');
    expect(vm.proofCta()).toBe('View proof — 2/2 green');
    expect(vm.proofRecommendation()).toBe('Tessa recommends accepting.');

    vm.openProof();
    expect(vm.mode()).toBe('proof');
    vm.backToTicket();
    expect(vm.mode()).toBe('ticket');

    // Without criteria the CTA stays hidden.
    const bare = setupFaces(makeFake({ docValue: { ...DOC, text: '## Description\n\nNothing verified.' } }));
    expect(bare.proofCta()).toBeNull();
    expect(bare.proofRecommendation()).toBeNull();
  });

  it('switching tickets resets the face, the draft and the option card', () => {
    const fake = makeFake({ docValue: { ...DOC, text: PROOF_TEXT } });
    const vm = setupFaces(fake, { chat: chatState([{ role: 'owner', text: 'T-0042: hi', thought: null, at: '' }]) });
    vm.openThread();
    expect(vm.mode()).toBe('thread');
    expect(vm.threadDraft()).toBe('T-0042: ');

    fake.docValue = { ...DOC, id: 'T-0043', text: '' };
    TestBed.flushEffects();
    expect(vm.mode()).toBe('ticket');
    expect(vm.threadDraft()).toBe('');
    expect(vm.threadQDone()).toBe(false);
  });

  it("the thread CTA names the asking persona; without a question need it's the ghost", () => {
    const asking = setupFaces(makeFake({ docValue: FULL_DOC }), {
      work: workState({
        needs: [ASKING_NEED],
        board: {
          columns: [
            {
              phase: { id: 'verify', title: 'Verify' },
              tickets: [{ id: 'T-0042', title: null, meta: { persona: 'pia' } }],
            },
          ],
        },
        personas: [{ id: 'pia', title: 'Pia', color: '#a78bfa' }],
      }),
    });
    expect(asking.threadCta()).toBe("Answer Pia's question");
    expect(asking.questionNeed()).not.toBeNull();
    expect(asking.questionCard()).not.toBeNull();
    expect(asking.threadPersona()).toEqual({ title: 'Pia', color: '#a78bfa' });
    expect(asking.threadPersonaLabel()).toBe('Pia');

    const ghost = setupFaces(makeFake({ docValue: FULL_DOC }), { work: workState() });
    expect(ghost.threadCta()).toBe('Open thread');
    expect(ghost.questionCard()).toBeNull();
    // No board pin and no gate persona — the chip and the label degrade honestly.
    expect(ghost.threadPersona()).toBeNull();
    expect(ghost.threadPersonaLabel()).toBe('T-0042');
  });

  it('the thread filters the active session and the composer sends into it, prefilled', async () => {
    const sent: string[] = [];
    const chat = chatState(
      [
        { role: 'owner', text: 'T-0042: the palette race', thought: null, at: '2026-11-02T09:12:00Z' },
        { role: 'owner', text: 'unrelated grumbling', thought: null, at: '2026-11-02T09:13:00Z' },
      ],
      [{ id: 'p-1', state: 'confirmed', summary: 'Move T-0042 to done', at: '2026-11-02T09:14:00Z' }],
    );
    chat.send = (text: string) => {
      sent.push(text);
      return Promise.resolve({ ok: true });
    };
    const vm = setupFaces(makeFake({ docValue: FULL_DOC }), { chat });
    vm.openThread();
    expect(vm.threadItems()).toHaveLength(2);
    expect(vm.threadDraft()).toBe('T-0042: ');

    vm.onThreadDraft(noteEvent('T-0042: do it this way'));
    await vm.threadSend();
    expect(sent).toEqual(['T-0042: do it this way']);
    expect(vm.threadDraft()).toBe('');
    expect(vm.threadError()).toBeNull();
  });

  it('without an open session the composer starts one; a refusal surfaces inline', async () => {
    const started: string[] = [];
    const chat: McChatState = {
      ...disconnectedChatState(),
      chat: signal<ChatStateView>({ sessions: [], active: null }),
      newSession: (text: string) => {
        started.push(text);
        return Promise.resolve({ ok: true });
      },
    };
    const vm = setupFaces(makeFake({ docValue: FULL_DOC }), { chat });
    vm.openThread();
    vm.onThreadDraft(noteEvent('T-0042: first words'));
    await vm.threadSend();
    expect(started).toEqual(['T-0042: first words']);

    const refusing: McChatState = { ...chat, newSession: () => Promise.resolve({ ok: false, error: 'not connected' }) };
    const vm2 = setupFaces(makeFake({ docValue: FULL_DOC }), { chat: refusing });
    vm2.openThread();
    vm2.onThreadDraft(noteEvent('T-0042: again'));
    await vm2.threadSend();
    expect(vm2.threadError()).toBe('not connected');
    expect(vm2.threadDraft()).not.toBe('');
  });

  it("the thread's option card marks only — sending acts once, then the card is done", async () => {
    const answers: { runId: string; text: string }[] = [];
    const toasts: string[] = [];
    const vm = setupFaces(makeFake({ docValue: FULL_DOC }), {
      work: {
        ...workState({ needs: [ASKING_NEED] }),
        answer: (runId, text) => {
          answers.push({ runId, text });
          return Promise.resolve({ ok: true });
        },
        toast: (message) => toasts.push(message),
      },
    });
    const card = vm.questionCard()!;
    expect(card.options[1]!.recommended).toBe(true);
    expect(vm.threadQSendLabel(card)).toBe('Send answer');

    vm.threadQSelect(1);
    expect(vm.threadQSelected()).toBe(1);
    expect(vm.threadQSendLabel(card)).toBe('Send “Right”');
    await vm.threadQSend();
    expect(answers).toEqual([{ runId: 'r-1', text: '2. Right' }]);
    expect(vm.threadQDone()).toBe(true);
    // No pin, no gate persona: the done line names the ticket.
    expect(toasts).toEqual(['Answer sent — T-0042 keeps running']);

    // A refusal lands inline and leaves the card answerable.
    const refusing = setupFaces(makeFake({ docValue: FULL_DOC }), {
      work: {
        ...workState({ needs: [ASKING_NEED] }),
        answer: () => Promise.resolve({ ok: false, error: 'the run is gone' }),
      },
    });
    refusing.threadQSelect(0);
    await refusing.threadQSend();
    expect(refusing.threadQDone()).toBe(false);
    expect(refusing.threadQError()).toBe('the run is gone');
  });
});

/** The shaped question the option-card specs reuse. */
function cardQuestionShaped(): McShapedQuestion {
  return {
    question: 'Which way?',
    context: null,
    where: null,
    why: null,
    options: [
      { n: 1, label: 'Left', consequence: 'the left way' },
      { n: 2, label: 'Right', consequence: null },
    ],
    recommended: 2,
    recommendationWhy: null,
  };
}

// --- diff review (E11-2) ------------------------------------------------------------------

const REVIEW_PATCH = [
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -3,3 +3,4 @@',
  ' three',
  '-four',
  '+FOUR',
  '+FOUR-B',
  ' five',
  '@@ -9,2 +10,2 @@',
  ' nine',
  '-ten',
  '+TEN',
].join('\n');
const REVIEW_FILE = Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join('\n') + '\n';

describe('wholeFileRowsOf', () => {
  it('lays the patch over the whole file: gaps become context, hunk headers drop out', () => {
    const rows = wholeFileRowsOf(REVIEW_PATCH, REVIEW_FILE);
    // The new file has 12 lines; the removed ones come in on top.
    expect(rows.filter((r) => r.kind !== 'del').map((r) => r.newNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(rows.some((r) => r.kind === 'hunk')).toBe(false);
    expect(rows.slice(0, 2)).toEqual([
      { kind: 'context', oldNo: 1, newNo: 1, sign: '', text: 'line1' },
      { kind: 'context', oldNo: 2, newNo: 2, sign: '', text: 'line2' },
    ]);
    const changed = rows.filter((r) => r.kind === 'add' || r.kind === 'del').map((r) => `${r.sign}${r.text}`);
    expect(changed).toEqual(['−four', '+FOUR', '+FOUR-B', '−ten', '+TEN']);
    // After the first hunk the old numbering runs one behind the new one.
    expect(rows.find((r) => r.newNo === 6)!.oldNo).toBe(5);
    expect(rows.find((r) => r.newNo === 11)!.oldNo).toBeNull(); // the added TEN
    expect(rows.find((r) => r.newNo === 12)!.oldNo).toBe(11);
  });

  it('survives a file shorter than the patch claims', () => {
    expect(() => wholeFileRowsOf(REVIEW_PATCH, 'only\n')).not.toThrow();
    expect(wholeFileRowsOf('', 'a\nb\n').map((r) => r.text)).toEqual(['a', 'b']);
  });
});

describe('changeRowsOf', () => {
  it('numbers the contiguous runs of added/removed rows and marks their first row', () => {
    const rows = changeRowsOf(patchRowsOf(REVIEW_PATCH));
    expect(changeCountOf(rows)).toBe(2);
    expect(rows.filter((r) => r.first).map((r) => [r.change, r.row.text])).toEqual([
      [0, 'four'],
      [1, 'ten'],
    ]);
    expect(rows.filter((r) => r.change === 0)).toHaveLength(3);
  });

  it('reports none for an unchanged or empty list', () => {
    expect(changeCountOf(changeRowsOf([]))).toBe(0);
  });
});

describe('viewedKeyOf', () => {
  it('changes with the patch, so an edited file reads as not viewed again', () => {
    expect(viewedKeyOf('a.ts', 'x')).toBe(viewedKeyOf('a.ts', 'x'));
    expect(viewedKeyOf('a.ts', 'x')).not.toBe(viewedKeyOf('a.ts', 'y'));
    expect(viewedKeyOf('a.ts', 'x')).not.toBe(viewedKeyOf('b.ts', 'x'));
  });
});

describe('TicketView diff review', () => {
  const files = [
    { status: 'M', path: 'src/a.ts', patch: REVIEW_PATCH, added: 3, removed: 2 },
    { status: 'M', path: 'src/b.ts', patch: '@@ -1 +1 @@\n-x\n+y', added: 1, removed: 1 },
  ];

  beforeEach(() => {
    localStorage.clear();
  });

  it('counts viewed files per device and keeps the marks across a remount', () => {
    const fake = makeFake({ docValue: DOC, diffValue: { files, truncated: false } });
    const vm = surface(setup(fake));
    expect(vm.viewedCount()).toBe(0);
    vm.toggleViewed(files[0]);
    expect(vm.isViewed(files[0])).toBe(true);
    expect(vm.viewedCount()).toBe(1);
    vm.toggleViewed(files[0]);
    expect(vm.viewedCount()).toBe(0);

    vm.toggleViewed(files[1]);
    const again = surface(setup(makeFake({ docValue: DOC, diffValue: { files, truncated: false } })));
    expect(again.viewedCount()).toBe(1);
    // A changed patch is a different file to review.
    expect(again.isViewed({ ...files[1], patch: '@@ -1 +1 @@\n-x\n+z' })).toBe(false);
  });

  it('offers the whole file only when the adapter can fetch it, and shows it once it arrives', () => {
    const plain = surface(setup(makeFake({ docValue: DOC, diffValue: { files, truncated: false } })));
    expect(plain.canShowWhole()).toBe(false);

    const fake = makeFake({ docValue: DOC, diffValue: { files, truncated: false } });
    let arrived = false;
    fake.wholeFile = () => (arrived ? { text: REVIEW_FILE, truncated: false } : null);
    const vm = surface(setup(fake));
    expect(vm.canShowWhole()).toBe(true);
    expect(vm.rowsOf(files[0])).toHaveLength(changeRowsOf(patchRowsOf(REVIEW_PATCH)).length);

    vm.setWhole('src/a.ts', true);
    expect(vm.loadingWhole(files[0])).toBe(true);
    arrived = true;
    expect(vm.loadingWhole(files[0])).toBe(false);
    expect(vm.rowsOf(files[0]).length).toBeGreaterThan(12);
    vm.setWhole('src/a.ts', false);
    expect(vm.isWhole('src/a.ts')).toBe(false);
  });

  it('steps through the changes and crosses into the next file', () => {
    const fake = makeFake({ docValue: DOC, diffValue: { files, truncated: false } });
    const vm = surface(setup(fake));
    const host = document.createElement('div');
    expect(vm.changeCount(files[0])).toBe(2);
    expect(vm.changeIndex(files[0])).toBe(0);
    vm.stepChange(files[0], 1, host);
    expect(vm.changeIndex(files[0])).toBe(1);
    vm.stepChange(files[0], 1, host);
    // Past the last change of a.ts the next file opens at its first.
    expect(vm.isExpanded('src/b.ts')).toBe(true);
    expect(vm.changeIndex(files[1])).toBe(0);
    vm.stepChange(files[1], -1, host);
    expect(vm.changeIndex(files[0])).toBe(1);
    // No file before the first one: nothing moves.
    vm.stepChange(files[0], -1, host);
    vm.stepChange(files[0], -1, host);
    expect(vm.changeIndex(files[0])).toBe(0);
  });
});

// --- line comments (E11-3) ----------------------------------------------------------------

describe('comment wording', () => {
  it('names a line, a range and the send-back button', () => {
    expect(commentLabelOf({ line: 27, endLine: null })).toBe('Line 27');
    expect(commentLabelOf({ line: 30, endLine: 33 })).toBe('Lines 30–33');
    expect(sendBackLabelOf(0)).toBe('Send back…');
    expect(sendBackLabelOf(1)).toBe('Send back with 1 comment…');
    expect(sendBackLabelOf(2)).toBe('Send back with 2 comments…');
  });
});

describe('TicketView line comments', () => {
  const file = { status: 'M', path: 'src/a.ts', patch: REVIEW_PATCH, added: 3, removed: 2 };
  const other = { status: 'M', path: 'src/b.ts', patch: '@@ -1 +1 @@\n-x\n+y', added: 1, removed: 1 };

  beforeEach(() => {
    localStorage.clear();
  });

  function mountReview(): { fake: FakeTicket; vm: TicketSurface } {
    const fake = makeFake({ docValue: DOC, diffValue: { files: [file, other], truncated: false } });
    return { fake, vm: surface(setup(fake)) };
  }

  it('opens the composer on a tapped line and stretches it into a range on a second tap', () => {
    const { vm } = mountReview();
    vm.pickLine(file, 27);
    expect(vm.draft()).toEqual({ file: 'src/a.ts', line: 27, endLine: null, index: null });
    expect(vm.draftAfter('src/a.ts', 27)).toBe(true);
    vm.pickLine(file, 30);
    expect(vm.draft()).toEqual({ file: 'src/a.ts', line: 27, endLine: 30, index: null });
    expect(vm.draftAfter('src/a.ts', 30)).toBe(true);
    expect(vm.draftAfter('src/a.ts', 27)).toBe(false);
    expect(vm.inDraft('src/a.ts', 28)).toBe(true);
    expect(vm.inDraft('src/a.ts', 31)).toBe(false);
    // Tapping above the start moves the start up.
    vm.pickLine(file, 25);
    expect(vm.draft()).toMatchObject({ line: 25, endLine: 30 });
    // A tap in another file starts a fresh comment there.
    vm.pickLine(other, 1);
    expect(vm.draft()).toEqual({ file: 'src/b.ts', line: 1, endLine: null, index: null });
    // A deleted line has no number in the new file: nothing happens.
    vm.cancelDraft();
    vm.pickLine(file, null);
    expect(vm.draft()).toBeNull();
  });

  it('adds, edits and deletes comments, keeping them across a remount', () => {
    const { vm } = mountReview();
    vm.pickLine(file, 27);
    vm.addDraft();
    expect(vm.comments()).toEqual([]); // an empty text adds nothing
    vm.onDraftText(noteEvent('  Why   here?  '));
    vm.addDraft();
    expect(vm.comments()).toEqual([{ file: 'src/a.ts', line: 27, endLine: null, text: 'Why here?' }]);
    expect(vm.draft()).toBeNull();
    expect(vm.commentsAfter('src/a.ts', 27).map((c) => c.comment.text)).toEqual(['Why here?']);
    expect(vm.sendBackLabel()).toBe('Send back with 1 comment…');

    vm.editComment(0);
    expect(vm.draftText()).toBe('Why here?');
    expect(vm.commentsAfter('src/a.ts', 27)).toEqual([]); // the card gives way to the composer
    vm.onDraftText(noteEvent('Move it into the caller.'));
    vm.addDraft();
    expect(vm.comments()[0]!.text).toBe('Move it into the caller.');

    const again = surface(setup(makeFake({ docValue: DOC, diffValue: { files: [file, other], truncated: false } })));
    expect(again.comments()).toHaveLength(1);

    vm.deleteComment(0);
    expect(vm.comments()).toEqual([]);
    expect(vm.sendBackLabel()).toBe('Send back…');
  });

  it('sends the comments along, lets them stand in for the note and clears them afterwards', async () => {
    const { fake, vm } = mountReview();
    vm.pickLine(file, 30);
    vm.pickLine(file, 33);
    vm.onDraftText(noteEvent('Rename.'));
    vm.addDraft();

    vm.toggleSendBack();
    await vm.sendBack(); // no note, one comment
    expect(fake.calls.sendBack).toEqual(['']);
    expect(fake.sentComments).toEqual([{ file: 'src/a.ts', line: 30, endLine: 33, text: 'Rename.' }]);
    expect(vm.comments()).toEqual([]);
    expect(vm.sendBackOpen()).toBe(false);
  });

  it('keeps the comments when the send-back is refused', async () => {
    const fake = makeFake({
      docValue: DOC,
      diffValue: { files: [file], truncated: false },
      sendBackReply: { ok: false, error: 'no agent phase' },
    });
    const vm = surface(setup(fake));
    vm.pickLine(file, 27);
    vm.onDraftText(noteEvent('Why?'));
    vm.addDraft();
    vm.toggleSendBack();
    await vm.sendBack();
    expect(vm.comments()).toHaveLength(1);
    expect(vm.sendBackOpen()).toBe(true);
  });
});

// --- the cost table and the estimate (E11-4) ------------------------------------------------

describe('costTableOf', () => {
  const run = (patch: Record<string, unknown> = {}) => ({
    phase: 'build',
    persona: 'ben',
    model: 'sonnet',
    tokens: '48k',
    cost: 0.3,
    dauer: '9m',
    ausgang: 'handed-over',
    ...patch,
  });
  const title = (id: string): string => ({ build: 'Build', review: 'Review' })[id] ?? id;

  it('makes one row per settled run and totals cost and time', () => {
    const table = costTableOf(
      [run(), run({ phase: 'review', persona: 'ralf', model: 'haiku', cost: 0.04, dauer: '1m', tokens: '12k' })] as never,
      title,
    );
    expect(table.rows).toEqual([
      { step: 'Build', who: 'Ben · sonnet', time: '9 min', tokens: '48k', cost: '$0.30', outcome: 'handed over' },
      { step: 'Review', who: 'Ralf · haiku', time: '1 min', tokens: '12k', cost: '$0.04', outcome: 'handed over' },
    ]);
    expect(table.total).toBe('$0.34');
    expect(table.totalTime).toBe('10 min');
  });

  it('never counts an unknown cost or time as zero', () => {
    const table = costTableOf([run({ cost: null, dauer: '', persona: null, model: null, ausgang: 'failed', phase: null })] as never, title);
    expect(table.rows[0]).toEqual({ step: '—', who: '', time: '', tokens: '48k', cost: '—', outcome: 'failed' });
    expect(table.total).toBeNull();
    expect(table.totalTime).toBeNull();
    expect(costTableOf([], title)).toEqual({ rows: [], total: null, totalTime: null });
  });
});

describe('the estimate sentence', () => {
  it('states figures and basis', () => {
    const est = { gate: 'build', persona: 'ben', model: 'sonnet', runs: 6, cost: 0.3, minutes: 9, tokens: 48_000 };
    expect(estimateLineOf(est, 'Build')).toBe('About $0.30 · 9 min · 48k tokens — median of 6 earlier Build runs by Ben on sonnet.');
    expect(estimateLineOf({ ...est, minutes: null, tokens: null }, 'Build')).toBe(
      'About $0.30 — median of 6 earlier Build runs by Ben on sonnet.',
    );
  });

  it('writes tokens as the Log does', () => {
    expect(tokenWordsOf(800)).toBe('800');
    expect(tokenWordsOf(48_000)).toBe('48k');
    expect(tokenWordsOf(3_400_000)).toBe('3.4M');
  });
});

// --- the shared plan (E10-2) ----------------------------------------------------------------

describe('planStatusLineOf / planChipOf', () => {
  const plan = (edits: number, version: number | null = 7) => ({ version, edits, summary: null, marks: [] });

  it('says which plan version the model saw and how many edits of yours came since', () => {
    expect(planStatusLineOf(plan(1))).toBe('The model saw plan v7 · 1 edit of yours since');
    expect(planStatusLineOf(plan(3))).toBe('The model saw plan v7 · 3 edits of yours since');
    expect(planStatusLineOf(plan(0))).toBe('The model saw plan v7 · no edits of yours since');
    expect(planStatusLineOf(plan(2, null))).toBeNull();
  });

  it('words the chip, and has none when nothing would go along', () => {
    expect(planChipOf(plan(1))).toBe('1 new edit of yours goes along');
    expect(planChipOf(plan(2))).toBe('2 new edits of yours go along');
    expect(planChipOf(plan(0))).toBeNull();
    expect(planChipOf(null)).toBeNull();
  });
});

describe('TicketView plan marks', () => {
  it('shows the status line and marks from the adapter, nothing without them', () => {
    const none = surface(setup(makeFake({ docValue: DOC })));
    expect(none.planState()).toBeNull();

    const fake = makeFake({ docValue: DOC });
    fake.plan = () => ({ version: 2, edits: 1, summary: '1 edit', marks: [{ no: 3, text: '- two', by: 'you' as const }] });
    const vm = surface(setup(fake));
    expect(vm.planState()).toEqual({ line: 'The model saw plan v2 · 1 edit of yours since', marks: [{ no: 3, text: '- two', by: 'you' }] });

    fake.plan = () => ({ version: null, edits: 0, summary: null, marks: [] });
    expect(surface(setup(fake)).planState()).toBeNull();
  });
});

describe('TicketView plan to approve (E10-4)', () => {
  interface ApproveSurface {
    planParts(): number;
    canApprove(): boolean;
    approvePlan(): void;
  }
  const PARTS_TEXT = '## Plan\n\n### Parts\n\n- [ ] One\n- [ ] Two\n- [ ] Three\n\n## Log\n\n- x\n';
  const approveOf = (fake: unknown): ApproveSurface => setup(fake as TicketVm) as unknown as ApproveSurface;

  it('offers the approval from two parts on, on a ticket that is not finished', () => {
    const opened: string[] = [];
    const fake = { ...makeFake({ docValue: { ...DOC, phase: 'prioritized', text: PARTS_TEXT } }), approvePlan: (id: string) => opened.push(id) };
    const view = approveOf(fake);
    expect(view.planParts()).toBe(3);
    expect(view.canApprove()).toBe(true);
    view.approvePlan();
    expect(opened).toEqual(['T-0042']);
  });

  it('stays quiet for one part, a finished ticket and an adapter without the action', () => {
    const onePart = '## Plan\n\n### Parts\n\n- [ ] One\n';
    const one = { ...makeFake({ docValue: { ...DOC, phase: 'prioritized', text: onePart } }), approvePlan: () => undefined };
    expect(approveOf(one).canApprove()).toBe(false);
    const last = PHASES[PHASES.length - 1]!.id;
    const finished = { ...makeFake({ docValue: { ...DOC, phase: last, text: PARTS_TEXT } }), approvePlan: () => undefined };
    expect(approveOf(finished).canApprove()).toBe(false);
    const without = makeFake({ docValue: { ...DOC, phase: 'prioritized', text: PARTS_TEXT } });
    expect(approveOf(without).canApprove()).toBe(false);
  });
});
