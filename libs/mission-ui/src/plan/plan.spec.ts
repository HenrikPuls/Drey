import { describe, expect, it, vi } from 'vitest';
import { type WritableSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ActiveSession, ChatMessageView, ChatStateView, McPlanStatus } from '../api/dto';
import { parseActiveSession, parseSessions } from '../api/dto';
import { Chat } from '../chat/chat';
import { MC_CHAT_STATE, type McChatState } from '../chat/chat.model';
import { PlanPane } from './plan-pane';
import {
  MC_PLAN_STATE,
  markedLinesOf,
  openQuestionCountOf,
  planChaptersOf,
  planPartsOf,
  planRowSubtitleOf,
  planSectionOf,
  replacePlanSection,
  splitLabelOf,
  type McPlanDoc,
  type McPlanState,
} from './plan.model';

const PLAN = [
  '### Goal',
  '',
  'A ticket in Ideas from anywhere in Windows.',
  '',
  '### Architecture',
  '',
  '```mermaid',
  'flowchart LR',
  '### not a heading',
  '```',
  '',
  '### Parts',
  '',
  '- [ ] Capture window',
  '  persona: ben',
  '  reason: a second chord beside quick capture',
  '- [ ] Tidy-up',
  '  persona: ben',
  '',
  '### Open questions',
  '',
  '- Which chord?',
  '- Typing fallback?',
].join('\n');

const ticket = (plan: string): string => `---\nid: T-0130\n---\n\n## Description\n\nx\n\n## Plan\n\n${plan}\n\n## Log\n\n- one\n`;

describe('reading the plan', () => {
  it('cuts the Plan section out of the ticket file', () => {
    expect(planSectionOf(ticket('### Goal\n\nx'))).toBe('### Goal\n\nx');
    expect(planSectionOf('## Description\n\nx\n')).toBe('');
  });

  it('splits chapters by ### heading and leaves a fenced ### alone', () => {
    const chapters = planChaptersOf(PLAN);
    expect(chapters.map((c) => c.title)).toEqual(['Goal', 'Architecture', 'Parts', 'Open questions']);
    expect(chapters[1]!.body).toContain('### not a heading');
  });

  it('lists the parts with their persona and reason', () => {
    expect(planPartsOf(PLAN)).toEqual([
      { title: 'Capture window', persona: 'ben', reason: 'a second chord beside quick capture' },
      { title: 'Tidy-up', persona: 'ben', reason: null },
    ]);
    expect(planPartsOf('### Goal\n\nx')).toEqual([]);
  });

  it('counts open questions and words the phone row', () => {
    expect(openQuestionCountOf(PLAN)).toBe(2);
    expect(planRowSubtitleOf(PLAN)).toBe('2 parts · 2 open questions');
    expect(planRowSubtitleOf('### Goal\n\nx')).toBeNull();
    expect(planRowSubtitleOf('### Parts\n\n- [ ] One\n\n### Open questions\n\n- Which?')).toBe('1 part · 1 open question');
  });

  it('words the split button by N, never a fixed number', () => {
    expect(splitLabelOf(3)).toBe('Split into 3 tickets');
    expect(splitLabelOf(5)).toBe('Split into 5 tickets');
  });

  it('lets a “you” mark win over a “model” mark on one line', () => {
    const status: McPlanStatus = {
      version: 1,
      edits: 1,
      summary: '1 edit',
      marks: [
        { no: 2, text: 'a', by: 'model' },
        { no: 2, text: 'a', by: 'you' },
        { no: 3, text: 'b', by: 'model' },
      ],
    };
    expect([...markedLinesOf(status)]).toEqual([
      [2, 'you'],
      [3, 'model'],
    ]);
    expect(markedLinesOf(null).size).toBe(0);
  });
});

describe('replacePlanSection', () => {
  it('swaps only the chapter', () => {
    expect(replacePlanSection(ticket('old'), '### Goal\n\nnew')).toBe(ticket('### Goal\n\nnew'));
  });

  it('adds a Plan before the Log, and demotes a level-2 heading in the body', () => {
    const out = replacePlanSection('---\nid: T-1\n---\n\n## Description\n\nx\n\n## Log\n\n- one\n', 'a\n## Log\nb');
    expect(out).toContain('## Plan\n\na\n### Log\nb\n\n## Log\n\n- one');
    expect(out.match(/^## Log$/gm)).toHaveLength(1);
  });
});

describe('the DTO readers for shape sessions', () => {
  it('reads question and split cards, the sources and the model', () => {
    const session = parseActiveSession({
      file: 'tickets/_meta/chat/x.md',
      title: 'Shape',
      createdAt: '',
      ticket: 'T-0130',
      sources: ['CLAUDE.md', 'src/a.ts'],
      model: 'opus',
      messages: [
        { role: 'mission', text: 'Where?', at: 'a', thought: null, kind: 'question', options: [{ label: 'docs/', recommended: true }, { label: 'repo' }, { label: '' }] },
        { role: 'mission', text: 'Parts ship alone', at: 'b', thought: null, kind: 'split', parts: 3, decision: 'keep' },
        { role: 'mission', text: 'one choice only', at: 'c', thought: null, kind: 'question', options: [{ label: 'A' }] },
      ],
      proposals: [],
    })!;
    expect(session.sources).toEqual(['CLAUDE.md', 'src/a.ts']);
    expect(session.model).toBe('opus');
    expect(session.messages[0]).toMatchObject({ kind: 'question', options: [{ label: 'docs/', recommended: true }, { label: 'repo', recommended: false }] });
    expect(session.messages[1]).toMatchObject({ kind: 'split', parts: 3, decision: 'keep' });
    expect(session.messages[2]!.kind).toBeUndefined();
  });

  it('carries the ticket in the sessions listing', () => {
    expect(parseSessions([{ file: 'a.md', title: 'A', ticket: 'T-0130' }, { file: 'b.md', title: 'B' }]).map((s) => s.ticket)).toEqual(['T-0130', undefined]);
  });
});

// -- the chat's shape face -----------------------------------------------------

interface ChatSurface {
  shape(): { ticket: string; line: string; context: string | null } | null;
  openQuestion(): ChatMessageView | null;
  pickedLabel(): string | null;
  pick(label: string): void;
  sendPicked(): Promise<void>;
  openSplit(): ChatMessageView | null;
  decideSplit(choice: 'keep' | 'split'): Promise<void>;
  planRow(): { subtitle: string | null } | null;
}

function chatWith(
  active: ActiveSession | null,
  extra: Partial<McChatState> & { shapeTicket?: WritableSignal<string | null> } = {},
  plan: Partial<McPlanState> | null = null,
): { vm: ChatSurface; send: ReturnType<typeof vi.fn>; decide: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async () => ({ ok: true as const }));
  const decide = vi.fn(async () => ({ ok: true as const }));
  const fake = {
    chatPrefill: signal(null),
    chat: signal<ChatStateView>({ sessions: [], active }),
    send,
    shapeDecide: decide,
    ...extra,
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: MC_CHAT_STATE, useValue: fake as unknown as McChatState },
      ...(plan === null ? [] : [{ provide: MC_PLAN_STATE, useValue: plan as McPlanState }]),
    ],
  });
  return { vm: TestBed.runInInjectionContext(() => new Chat()) as unknown as ChatSurface, send, decide };
}

const session = (messages: ChatMessageView[], extra: Partial<ActiveSession> = {}): ActiveSession => ({
  file: 'tickets/_meta/chat/s.md',
  title: 'Shape',
  createdAt: '',
  messages,
  proposals: [],
  ticket: 'T-0130',
  ...extra,
});
const question: ChatMessageView = {
  role: 'mission',
  text: 'Where should the report live?',
  at: '2026-11-04T09:00:00Z',
  thought: null,
  kind: 'question',
  options: [
    { label: 'docs/security/', recommended: true },
    { label: 'Tickets repo', recommended: false },
  ],
};

describe('the chat in shape mode', () => {
  it('words the context line from the ticket, the model and the sources read', () => {
    const { vm } = chatWith(session([], { model: 'opus', sources: ['CLAUDE.md', 'roadmap.md', 'ADR-0073.md', 'a.ts', 'b.ts'] }));
    expect(vm.shape()).toEqual({
      ticket: 'T-0130',
      line: 'Shaping T-0130 with Paul · opus · reads only',
      context: 'Context: CLAUDE.md · roadmap.md · ADR-0073.md · +2',
    });
  });

  it('shows the line before the first message, from the ticket the entry point asked for', () => {
    const { vm } = chatWith(null, { shapeTicket: signal<string | null>('T-0130') });
    expect(vm.shape()?.line).toBe('Shaping T-0130 with Paul · reads only');
    expect(chatWith(null).vm.shape()).toBeNull();
    expect(chatWith({ ...session([]), ticket: null }).vm.shape()).toBeNull();
  });

  it('puts Paul’s open question above the composer: pick, then send — the pick sends nothing', async () => {
    const { vm, send } = chatWith(session([question]));
    expect(vm.openQuestion()?.text).toBe('Where should the report live?');
    expect(vm.pickedLabel()).toBeNull();
    vm.pick('docs/security/');
    expect(vm.pickedLabel()).toBe('docs/security/');
    expect(send).not.toHaveBeenCalled();
    await vm.sendPicked();
    expect(send).toHaveBeenCalledWith('docs/security/');
    expect(vm.pickedLabel()).toBeNull();
  });

  it('lets a second tap on the pick take it back, and sends nothing without one', async () => {
    const { vm, send } = chatWith(session([question]));
    vm.pick('Tickets repo');
    vm.pick('Tickets repo');
    expect(vm.pickedLabel()).toBeNull();
    await vm.sendPicked();
    expect(send).not.toHaveBeenCalled();
  });

  it('closes the answer block once the owner has answered', () => {
    const answered = [question, { role: 'owner', text: 'docs/security/', at: '2026-11-04T09:01:00Z', thought: null } as ChatMessageView];
    expect(chatWith(session(answered)).vm.openQuestion()).toBeNull();
  });

  it('offers the split decision on the latest undecided proposal only', async () => {
    const split: ChatMessageView = { role: 'mission', text: 'Parts ship alone', at: 'b', thought: null, kind: 'split', parts: 3, decision: null };
    const { vm, decide } = chatWith(session([split]));
    expect(vm.openSplit()).toBe(split);
    await vm.decideSplit('keep');
    expect(decide).toHaveBeenCalledWith('tickets/_meta/chat/s.md', 'keep');
    expect(chatWith(session([{ ...split, decision: 'split' }])).vm.openSplit()).toBeNull();
  });

  it('words the phone’s plan row from the loaded plan, and hides it without a plan state', () => {
    const doc = signal<McPlanDoc | null>({ id: 'T-0130', text: ticket(PLAN), revision: 'r' });
    const { vm } = chatWith(session([]), {}, { doc: () => doc() });
    expect(vm.planRow()).toEqual({ subtitle: '2 parts · 2 open questions' });
    doc.set(null);
    expect(vm.planRow()).toEqual({ subtitle: null });
    expect(chatWith(session([])).vm.planRow()).toBeNull();
  });
});

// -- the plan pane --------------------------------------------------------------

interface PaneSurface {
  plan(): string | null;
  chapters(): { key: string; parts: unknown[] }[];
  isOpen(key: string): boolean;
  toggle(key: string): void;
  editing(): boolean;
  error(): string | null;
  statusLine(): string | null;
  splitLabel(): string;
  onDraft(event: Event): void;
  toggleEdit(): Promise<void>;
  decide(choice: 'keep' | 'split'): Promise<void>;
}

function paneWith(overrides: Partial<McPlanState> = {}): { pane: PaneSurface; save: ReturnType<typeof vi.fn>; flush: { current: (() => Promise<boolean>) | null }; decide: ReturnType<typeof vi.fn> } {
  const save = vi.fn(async (_text: string) => ({ ok: true as const }));
  const decide = vi.fn(async () => ({ ok: true as const }));
  const flush: { current: (() => Promise<boolean>) | null } = { current: null };
  const state: McPlanState = {
    ticket: () => 'T-0130',
    doc: () => ({ id: 'T-0130', text: ticket(PLAN), revision: 'r1' }),
    status: () => ({ version: 7, edits: 1, summary: '1 edit', marks: [] }),
    proposal: () => ({ parts: 4, reason: 'Each part ships and tests on its own' }),
    decide,
    save,
    reload: async () => undefined,
    setFlush: (f) => {
      flush.current = f;
    },
    ...overrides,
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [{ provide: MC_PLAN_STATE, useValue: state }] });
  return { pane: TestBed.runInInjectionContext(() => new PlanPane()) as unknown as PaneSurface, save, flush, decide };
}

describe('the plan pane', () => {
  it('lists the chapters collapsed except Goal and Parts, with the part count on Parts', () => {
    const { pane } = paneWith();
    expect(pane.chapters().map((c) => c.key)).toEqual(['goal', 'architecture', 'parts', 'open questions']);
    expect(pane.isOpen('goal')).toBe(true);
    expect(pane.isOpen('parts')).toBe(true);
    expect(pane.isOpen('architecture')).toBe(false);
    pane.toggle('architecture');
    expect(pane.isOpen('architecture')).toBe(true);
    expect(pane.chapters().find((c) => c.key === 'parts')!.parts).toHaveLength(2);
  });

  it('shows the model’s version and the owner’s edits, and N from the proposal', () => {
    const { pane } = paneWith();
    expect(pane.statusLine()).toBe('The model saw plan v7 · 1 edit of yours since');
    expect(pane.splitLabel()).toBe('Split into 4 tickets');
  });

  it('saves an edit when Done is pressed — only the Plan chapter changes', async () => {
    const { pane, save, flush } = paneWith();
    await pane.toggleEdit();
    expect(pane.editing()).toBe(true);
    expect(flush.current).not.toBeNull();
    pane.onDraft({ target: { value: '### Goal\n\nchanged' } } as unknown as Event);
    await pane.toggleEdit();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toBe(ticket('### Goal\n\nchanged'));
    expect(pane.editing()).toBe(false);
    expect(flush.current).toBeNull();
  });

  it('saves nothing when the text did not change', async () => {
    const { pane, save } = paneWith();
    await pane.toggleEdit();
    await pane.toggleEdit();
    expect(save).not.toHaveBeenCalled();
  });

  it('stays in edit mode and says why when the save is refused; the flush then reports false', async () => {
    const { pane, flush } = paneWith({ save: async () => ({ ok: false, error: 'The plan changed since you opened it.' }) });
    await pane.toggleEdit();
    pane.onDraft({ target: { value: 'x' } } as unknown as Event);
    await pane.toggleEdit();
    expect(pane.editing()).toBe(true);
    expect(pane.error()).toBe('The plan changed since you opened it.');
    expect(await flush.current!()).toBe(false);
  });

  it('hands the decision to the state', async () => {
    const { pane, decide } = paneWith();
    await pane.decide('keep');
    expect(decide).toHaveBeenCalledWith('keep');
  });
});
