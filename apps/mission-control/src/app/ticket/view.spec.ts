/**
 * The ticket screen's specs (E5c): the pure helpers — the gate-bar step
 * builder, the section splitter, the proof reader, the scout report
 * reader (E8), the armed two-step reducer, the fullscreen font-size
 * steps, the patch line kinds — then the component class against a fake
 * `TicketVm`, no DOM (the unit-test builder runs these under jsdom, but
 * nothing here renders a template). The raw editor's own specs live in
 * `edit.spec.ts`.
 */
import { TestBed } from '@angular/core/testing';
import {
  ACCEPT_DISARMED,
  DEFAULT_DIFF_FONT_SIZE,
  MC_TICKET,
  acceptArmReduce,
  diffFontSizeStep,
  gateStepsOf,
  patchLineKind,
  phaseTitleOf,
  proofOf,
  scoutReportOf,
  splitTicketSections,
  type GatePhase,
  type TicketActionReply,
  type TicketDiff,
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
  calls: { accept: number; sendBack: string[]; save: string[]; onClose: number; enterEdit: number; exitEdit: number; reload: number };
  acceptReply: TicketActionReply;
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
    },
    acceptReply: { ok: true } as TicketActionReply,
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
    save(text: string): Promise<TicketSaveReply> {
      this.calls.save.push(text);
      return Promise.resolve(this.saveReply);
    },
    accept(): Promise<TicketActionReply> {
      this.calls.accept += 1;
      return Promise.resolve(this.acceptReply);
    },
    sendBack(note: string): Promise<TicketActionReply> {
      this.calls.sendBack.push(note);
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
};

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

## Log

- '2026-10-17T14:32:00Z' owner — created in inbox

## Result

It works.
`;

const FULL_DOC: TicketDoc = { ...DOC, text: FULL_TEXT };

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
  readOnly(): boolean;
  steps(): ReturnType<typeof gateStepsOf>;
  blocks(): readonly unknown[];
  proof(): ReturnType<typeof proofOf> | null;
  report(): ReturnType<typeof scoutReportOf> | null;
  shots(): readonly { name: string; url: string }[];
  diff(): unknown;
  result(): { kind: 'error' | 'note'; text: string } | null;
  savedFlash(): string | null;
  arm(): { armed: boolean; since: number };
  acceptPending(): boolean;
  acceptTap(): void;
  sendBackOpen(): boolean;
  note(): string;
  sendBackPending(): boolean;
  onNote(event: Event): void;
  toggleSendBack(): void;
  sendBack(): Promise<void>;
  toggleEdit(): void;
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

describe('phaseTitleOf', () => {
  it('resolves the current phase title and falls back to the raw id', () => {
    expect(phaseTitleOf(PHASES, 'verify')).toBe('Verify');
    expect(phaseTitleOf(PHASES, 'limbo')).toBe('limbo');
    expect(phaseTitleOf([], 'verify')).toBe('verify');
  });
});

// --- the section splitter ------------------------------------------------------------

describe('splitTicketSections', () => {
  it('pulls Verification, Changes, Handover and Log out of the generic render', () => {
    const sections = splitTicketSections(FULL_TEXT);
    expect(sections.body).toContain('## Description');
    expect(sections.body).toContain('### Acceptance criteria');
    expect(sections.body).toContain('## Result');
    expect(sections.body).not.toContain('Tested on');
    expect(sections.body).not.toContain('created in inbox');
    expect(sections.verification).toContain('Tested on 2026-11-01T14:32:00Z');
    expect(sections.verification).not.toContain('## Verification');
    expect(sections.changes).toBe('**What changed for you:** The command palette opens once.');
    expect(sections.handover).toBe('State: done');
    expect(sections.log).toContain("'2026-10-17T14:32:00Z' owner — created in inbox");
  });

  it('never lets the frontmatter reach the render', () => {
    const sections = splitTicketSections(FULL_TEXT);
    expect(sections.body).not.toContain('id: T-0042');
    expect(sections.body.startsWith('## Description')).toBe(true);
  });

  it('matches the special titles case-insensitively and H3 headings ride inside', () => {
    const sections = splitTicketSections(
      '## verification\n\n- [x] `a`\n\n### Criteria\n\nx\n\n## LOG\n\n- line',
    );
    expect(sections.verification).toContain('### Criteria');
    expect(sections.log).toBe('- line');
  });

  it('reports absent sections as null and an all-generic file whole in the body', () => {
    const sections = splitTicketSections('## Description\n\nOnly this.\n');
    expect(sections.verification).toBeNull();
    expect(sections.report).toBeNull();
    expect(sections.changes).toBeNull();
    expect(sections.handover).toBeNull();
    expect(sections.log).toBeNull();
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

// --- the proof reader ------------------------------------------------------------------

describe('proofOf', () => {
  it('reads the stamp, the criteria with screenshots and notes, and the findings', () => {
    const verification = splitTicketSections(FULL_TEXT).verification!;
    const proof = proofOf(verification);
    expect(proof.testedOn).toBe(
      'Tested on 2026-11-01T14:32:00Z by verify@engine — Electron 34.2.0 on win32.',
    );
    expect(proof.criteria).toEqual([
      { command: 'npm run build', passed: true, screenshot: 'verify-20261101-143200-01.png', note: null },
      { command: 'npm test', passed: false, screenshot: null, note: 'no screenshot: the app never became ready' },
    ]);
    expect(proof.findings).toEqual(['The settings page stayed blank until the reload.']);
  });

  it('degrades honestly on half-readable sections', () => {
    expect(proofOf('')).toEqual({ testedOn: '', criteria: [], findings: [] });
    const loose = proofOf('- [x] checked by hand\n- [ ] `npm run build`\ngarbage line');
    expect(loose.criteria).toEqual([
      { command: 'checked by hand', passed: true, screenshot: null, note: null },
      { command: 'npm run build', passed: false, screenshot: null, note: null },
    ]);
    expect(loose.findings).toEqual([]);
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
    expect(vm.savedFlash()).toBeNull();
  });

  it('derives the header, the steps, the body blocks and the proof from the bound doc', () => {
    const vm = surface(setup(makeFake({ docValue: FULL_DOC })));
    expect(vm.isEmpty()).toBe(false);
    expect(vm.id()).toBe('T-0042');
    expect(vm.title()).toBe('Fix the palette race in CI');
    expect(vm.phaseTitle()).toBe('Verify');
    expect(vm.steps().map((step) => step.state)).toEqual(['past', 'current', 'future']);
    const headings = vm.blocks().filter((block) => (block as { kind: string }).kind === 'heading');
    expect(headings.map((block) => (block as { text: string }).text)).toEqual([
      'Description',
      'Plan',
      'Acceptance criteria',
      'Result',
    ]);
    expect(vm.proof()?.criteria).toHaveLength(2);
    expect(vm.proof()?.findings).toEqual(['The settings page stayed blank until the reload.']);
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
    const headings = vm.blocks().filter((block) => (block as { kind: string }).kind === 'heading');
    expect(headings.map((block) => (block as { text: string }).text)).toEqual(['Description']);
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

  it('expands one diff file at a time and keeps the font size across fullscreen', () => {
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

    vm.toggleExpanded('src/a.ts');
    expect(vm.isExpanded('src/a.ts')).toBe(true);
    expect(vm.isExpanded('src/b.ts')).toBe(false);
    vm.toggleExpanded('src/a.ts');
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
});
