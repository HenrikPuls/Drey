/**
 * Wave row 4.5: the sample of the phone boards (10a–10t) as a fake desk's
 * answers, so the fidelity spec can stand the built client in the state each
 * board draws. The screenshots are compared with the boards, nothing here is
 * asserted against. The clock the spec fixes is 2026-11-07 14:10 local.
 */
const at = (day: number, hour: number, minute: number): string => new Date(2026, 10, day, hour, minute).toISOString();
const NOW_DAY = 7;

const card = (id: string, phase: string, title: string, extra: Record<string, unknown> = {}, cost: number | null = null) => ({
  id,
  phase,
  meta: { id, title, priority: 'normal', claimedBy: null, persona: null, ...extra },
  blocked: [],
  ...(cost === null ? {} : { usage: { tokensIn: 1, tokensOut: 1, cost, runs: 1 } }),
});
const since = (phase: string, minutesAgo: number) => ({ entered: { [phase]: new Date(new Date(2026, 10, NOW_DAY, 14, 10).getTime() - minutesAgo * 60_000).toISOString() } });

const filler = (prefix: number, count: number, phase: string, word: string) =>
  Array.from({ length: count }, (_, i) => card(`T-${String(prefix + i).padStart(4, '0')}`, phase, `${word} ${i + 1}`));

export const BOARD = {
  vaultName: 'drey-tickets',
  checkpoints: ['plan-review'],
  recentDone: Array.from({ length: 5 }, (_, i) => ({ id: `T-00${10 + i}`, title: `Done ticket ${i + 1}` })),
  columns: [
    { phase: { id: 'inbox', title: 'Inbox' }, tickets: filler(200, 8, 'inbox', 'Idea') },
    {
      phase: { id: 'plan', title: 'Shaping' },
      tickets: [
        card('T-0130', 'plan', 'Voice capture for tickets', since('plan', 12), 0.61),
        card('T-0119', 'plan', 'Weekly security audit run', since('plan', 20 * 60), 0.18),
      ],
    },
    { phase: { id: 'prioritized', title: 'Prioritized' }, tickets: filler(300, 9, 'prioritized', 'Next') },
    {
      phase: { id: 'build', title: 'Building' },
      tickets: [
        card('T-0121', 'build', 'Outline: drag headings to reorder', { ...since('build', 4), persona: 'ben' }, 1.2),
        card('T-0126', 'build', 'Git panel: stage single hunks', { ...since('build', 30), persona: 'tessa' }, 2.05),
        card('T-0122', 'build', 'Win+H dictation hand-off', since('build', 3), 0),
      ],
    },
    {
      phase: { id: 'review', title: 'Ready to try' },
      tickets: [card('T-0118', 'review', 'Palette opens twice on slow CI', { ...since('review', 20), persona: 'tessa' }, 1.84)],
    },
    { phase: { id: 'done', title: 'Done' }, tickets: [] },
  ],
};

export const NEEDS = [
  {
    kind: 'question',
    ticketId: 'T-0121',
    title: 'Outline: drag headings to reorder',
    summary: 'Should dragging a heading also move the text below it?',
    runId: 'run-ben',
    shaped: {
      question: 'Should dragging a heading also move the text below it?',
      context: null,
      where: null,
      why: null,
      recommended: 1,
      recommendationWhy: null,
      options: [
        { n: 1, label: 'Move the whole section', consequence: 'one undo step, what other editors do' },
        { n: 2, label: 'Only the heading line', consequence: 'text stays, structure usually breaks' },
        { n: 3, label: 'Section; Alt-drag for the line only', consequence: 'both, one modifier to learn' },
      ],
    },
  },
  {
    kind: 'question',
    phase: 'plan',
    ticketId: 'T-0130',
    title: 'Voice capture for tickets',
    summary: 'One pushback: you removed “the dictated text stays in the Log”. Keep it?',
    runId: 'run-paul',
    shaped: {
      question: 'One pushback: you removed “the dictated text stays in the Log”. Keep it?',
      context: null,
      where: null,
      why: 'If the tidy-up misreads you, the original is the only way back.',
      recommended: 1,
      recommendationWhy: null,
      options: [
        { n: 1, label: 'Keep the raw text', consequence: 'the original stays in the Log' },
        { n: 2, label: 'Drop it', consequence: 'only the tidied text is kept' },
      ],
    },
  },
  { kind: 'checkpoint', phase: 'review', ticketId: 'T-0118', title: 'Palette opens twice on slow CI', summary: 'Ready to try.' },
];

const liveRun = (id: string, ticketId: string, persona: string, startedMin: number, activity: string, extra: Record<string, unknown> = {}) => ({
  id,
  ticketId,
  persona,
  provider: persona === 'ben' || persona === 'paul' ? 'opencode' : 'claude-code',
  state: 'running',
  phase: 'build',
  startedAt: new Date(new Date(2026, 10, NOW_DAY, 14, 10).getTime() - startedMin * 60_000).toISOString(),
  lastActivity: new Date(new Date(2026, 10, NOW_DAY, 14, 10).getTime() - (typeof extra['silentMin'] === 'number' ? (extra['silentMin'] as number) : 0) * 60_000).toISOString(),
  activity,
  endedAt: null,
  tokensIn: 48_213,
  tokensOut: 6_120,
  costUsd: 0.42,
  ...extra,
});

export const PERSONAS = [
  { id: 'paul', title: 'Paul', role: 'planner', worker: 'claude-code', model: 'sonnet', pool: ['claude-code'], color: '#f2d3e2', phases: ['shape', 'plan'], budget: 2, dailyCost: 0.61 },
  { id: 'ben', title: 'Ben', role: 'builder', worker: 'opencode', model: 'qwen3-coder', pool: ['opencode', 'claude-code'], color: '#8ecbef', phases: ['build'], budget: 5, dailyCost: 2.67 },
  { id: 'ralf', title: 'Ralf', role: 'reviewer', worker: 'claude-code', model: 'sonnet', pool: ['claude-code'], color: '#f2cfae', phases: ['review'], budget: 1, dailyCost: 0.46 },
  { id: 'tessa', title: 'Tessa', role: 'tester', worker: 'claude-code', model: 'sonnet', pool: ['claude-code'], color: '#93c47f', phases: ['test'], budget: 7, dailyCost: 0.36 },
];

export const FLEET = {
  runs: [
    liveRun('run-paul', 'T-0130', 'paul', 12, 'plan to accept · 3 parts'),
    liveRun('run-ben', 'T-0121', 'ben', 4, 'building · step 2 · waits for your answer'),
    liveRun('run-ralf', 'T-0118', 'ralf', 2, 'review starts after the build'),
    liveRun('run-tessa', 'T-0126', 'tessa', 30, 'testing · no output for 9 min', { stuck: true, silentMin: 9, contextTokens: 78, contextWindow: 100 }),
  ],
  chain: { configured: true, master: 'run', columns: { build: 'playing' }, poolSize: { opencode: 2, 'claude-code': 3 }, autopilot: { state: 'on', resumeAt: new Date(2026, 10, NOW_DAY, 18, 0).toISOString() } },
};

export const SESSIONS = [
  { file: 'tickets/_meta/chat/storage.md', title: 'Ship the storage scout and run the voice capture idea next', createdAt: at(NOW_DAY, 14, 0), updatedAt: at(NOW_DAY, 14, 2), pending: 0 },
  { file: 'tickets/_meta/chat/gate.md', title: 'T-0091: design gate before verify', createdAt: at(NOW_DAY, 10, 0), updatedAt: at(NOW_DAY, 10, 41), pending: 0 },
  { file: 'tickets/_meta/chat/week.md', title: 'What did the week cost?', createdAt: at(NOW_DAY - 1, 16, 0), updatedAt: at(NOW_DAY - 1, 16, 5), pending: 0 },
  { file: 'tickets/_meta/chat/away.md', title: 'Away until 18:00: merge only if green', createdAt: at(NOW_DAY - 1, 9, 0), updatedAt: at(NOW_DAY - 1, 9, 5), pending: 0 },
];

export const SESSION_CHAT = {
  file: SESSIONS[0]!.file,
  title: SESSIONS[0]!.title,
  createdAt: SESSIONS[0]!.createdAt,
  messages: [
    { role: 'owner', text: 'Ship the storage scout, then run the voice capture idea next.', at: at(NOW_DAY, 14, 1), thought: null },
    { role: 'mission', text: 'Both are queued. Ben is on T-0121, step 2 of 4, and has one question for you.', at: at(NOW_DAY, 14, 2), thought: null },
  ],
  proposals: [],
};

export const SESSION_PROPOSAL = {
  file: SESSIONS[1]!.file,
  title: SESSIONS[1]!.title,
  createdAt: SESSIONS[1]!.createdAt,
  messages: [
    { role: 'owner', text: 'Ship the storage scout and run the voice capture idea next.', at: at(NOW_DAY, 14, 1), thought: null },
    { role: 'mission', text: 'Two changes, each needs your OK:', at: at(NOW_DAY, 14, 2), thought: null },
  ],
  proposals: [
    { id: 'p-1', state: 'pending', summary: 'Promote T-0004 to a ship ticket', at: at(NOW_DAY, 14, 2) },
    { id: 'p-2', state: 'pending', summary: 'Move T-0063 from inbox to plan', at: at(NOW_DAY, 14, 2) },
  ],
};

const COST_121 = [
  '- {phase: plan, persona: paul, model: Claude sonnet, tokens: 21k, dauer: 4m, cost: 0.34, ausgang: done}',
  '- {phase: build, persona: ben, model: Claude sonnet, tokens: 52k, dauer: 9m, cost: 0.86, ausgang: running}',
].join('\n');

const COST_118 = [
  '- {phase: plan, persona: paul, model: Claude sonnet, tokens: 21k, dauer: 4m, cost: 0.31, ausgang: done}',
  '- {phase: build, persona: ben, model: Claude sonnet, tokens: 88k, dauer: 14m, cost: 0.94, ausgang: done}',
  '- {phase: review, persona: ralf, model: Claude sonnet, tokens: 30k, dauer: 5m, cost: 0.32, ausgang: done}',
  '- {phase: review, persona: tessa, model: Claude sonnet, tokens: 24k, dauer: 6m, cost: 0.27, ausgang: done}',
].join('\n');

export const TICKET_TEXT: Record<string, string> = {
  'T-0121': `---\nid: T-0121\n---\n\n## Goal\n\nDrag headings in the Outline panel to reorder the note. The text under a heading is part of the move.\n\n## Plan\n\n### Parts\n\n- Outline tree model\n- Drop handler\n- Reorder in the buffer\n- Manual test notes\n\n## Verlauf\n\n${COST_121}\n`,
  'T-0118': `---\nid: T-0118\n---\n\n## Verification\n\nTested on 2026-11-04 by Tessa\n\n- [x] One palette after a double Ctrl+P\n- [x] Escape closes it, the editor keeps focus\n- [x] A slow machine still opens one\n- [x] The second press does nothing\n\n## Verlauf\n\n${COST_118}\n`,
  'T-0130': `---\nid: T-0130\n---\n\n## Plan\n\n### Goal\n\nA ticket in Inbox from anywhere in Windows, typed or spoken, in under ten seconds.\n\n### Parts\n\n- Capture hotkey and window\n- Dictation hand-off (Win+H)\n- Ticket from transcript\n`,
};

export const PARTS_121 = {
  ok: true,
  ticket: 'T-0121',
  title: 'Outline: drag headings to reorder',
  gate: 'build',
  defaultPersona: 'ben',
  personas: PERSONAS.map((p) => ({ id: p.id, title: p.title, role: p.role, color: p.color, model: p.model })),
  warnings: [],
  parts: [
    { index: 0, title: 'Outline tree model', reason: null, persona: 'ben', chain: [], flow: [], ticket: 'T-0140', state: 'done', phase: 'done', locked: true, start: '' },
    { index: 1, title: 'Drop handler', reason: null, persona: 'ben', chain: [], flow: [], ticket: 'T-0141', state: 'running', phase: 'build', locked: true, start: '' },
    { index: 2, title: 'Reorder in the buffer', reason: null, persona: 'ben', chain: [], flow: [], ticket: null, state: 'new', phase: null, locked: false, start: '' },
    { index: 3, title: 'Manual test notes', reason: null, persona: 'tessa', chain: [], flow: [], ticket: null, state: 'new', phase: null, locked: false, start: '' },
  ],
};

export const PARTS_130 = {
  ok: true,
  ticket: 'T-0130',
  title: 'Voice capture for tickets',
  gate: 'build',
  defaultPersona: 'ben',
  personas: PERSONAS.map((p) => ({ id: p.id, title: p.title, role: p.role, color: p.color, model: p.model })),
  warnings: [],
  parts: [
    { index: 0, title: 'Capture hotkey and window', reason: 'a second chord beside quick capture', persona: 'ben', chain: [], flow: [], ticket: null, state: 'new', phase: null, locked: false, start: '' },
    { index: 1, title: 'Dictation hand-off (Win+H)', reason: 'typing as fallback', persona: 'ben', chain: [], flow: [], ticket: null, state: 'new', phase: null, locked: false, start: '' },
    { index: 2, title: 'Ticket from transcript', reason: 'one model call in the tickets plugin', persona: 'ben', chain: [], flow: [], ticket: null, state: 'new', phase: null, locked: false, start: '' },
  ],
};

export const PLAN_130 = { ok: true, version: 7, edits: 1, summary: null, marks: [{ no: 1, text: 'Dictation hand-off (Win+H)', by: 'you' }] };

const NOTE_MTIME = new Date(2026, 10, NOW_DAY, 9, 12).getTime();

/** The Notes board's vault: three folders, the five recent notes, the open note with its ticket. */
export const NOTES = new Map<string, { text: string; mtime: number }>([
  ['projects/Outline ideas.md', {
    text: '---\nticket: T-0121\n---\n# Outline ideas\n\n#outline #ideas\n\nDragging a heading in the Outline panel should move the whole section, not just the line.\n\n## Open points\n\n- [x] Move the section with its text\n- [ ] Alt-drag moves the line only?\n- [ ] Undo as one step\n',
    mtime: NOTE_MTIME,
  }],
  ['daily/2026-11-06.md', { text: '# 2026-11-06\n', mtime: new Date(2026, 10, NOW_DAY, 8, 0).getTime() }],
  ['projects/backlinks.md', { text: '# Storage\n', mtime: new Date(2026, 10, NOW_DAY - 1, 18, 0).getTime() }],
  ['templates/weekly review.md', { text: '# Weekly review\n', mtime: new Date(2026, 10, NOW_DAY - 5, 18, 0).getTime() }],
  ['ideas/voice capture.md', { text: '# Voice capture\n', mtime: new Date(2026, 9, 28, 18, 0).getTime() }],
]);

export const SETTINGS = {
  ok: true,
  engine: {
    chat: { providerLabel: 'Local', baseUrl: 'http://127.0.0.1:1234', model: 'qwen3-coder', hasKey: false, problem: null },
    videos: { inGit: false, maxMb: 50, existing: 0 },
  },
  devices: [
    { id: 'd1', name: 'iPhone', readOnly: false, pairedAt: at(1, 9, 0), lastSeen: at(NOW_DAY, 14, 0), current: true },
    { id: 'd2', name: 'iPad', readOnly: false, pairedAt: at(1, 9, 0), lastSeen: at(NOW_DAY, 9, 0), current: false },
  ],
};

const flow = (persona: string) => ['Plan', 'Build', 'Review', 'Test', 'Accept'].map((title) => ({ phase: title.toLowerCase(), title, persona: title === 'Build' ? persona : null, inserted: false, skipped: false, notify: false }));
for (const part of [...PARTS_121.parts, ...PARTS_130.parts]) {
  (part as { flow: unknown }).flow = flow(part.persona);
}

/** The estimates the boards' cost rows read, by gate and persona. */
const estimate = (gate: string, persona: string, model: string, cost: number, costLow: number, costHigh: number) => ({ ok: true, estimate: { gate, persona, model, runs: 3, cost, costLow, costHigh } });
export const ESTIMATES: Record<string, unknown> = {
  'build/ben': estimate('build', 'ben', 'qwen3-coder', 3, 2, 4),
  'review/tessa': estimate('review', 'tessa', 'sonnet', 2, 1.5, 2.4),
};

/**
 * Wave row 4.6: what only the iPad boards (5b-5i, 10e-10s) draw, laid over the
 * phone sample when the desk starts with `pad: true`. The phone's shots keep
 * their sample byte for byte.
 */
export const PAD_TICKET_TEXT: Record<string, string> = {
  'T-0118': `---\nid: T-0118\n---\n\n## Goal\n\nOne Ctrl+P opens one palette, also when the machine is slow and the key repeats.\n\n## Verification\n\nTested on 2026-11-04 by Tessa\n\n- [x] One palette after a double Ctrl+P\n- [x] Escape closes it, the editor keeps focus\n- [x] A slow machine still opens one\n- [x] The second press does nothing\n\n### Video\n\n![](../videos/t-0118.webm)\n\n- 0:48 The second press does nothing\n\n## Verlauf\n\n${COST_118}\n`,
};

/** Board 5b / 5c: T-0130 as it reads while Paul shapes it: the chapters the Shaping face draws as rows. */
PAD_TICKET_TEXT['T-0130'] = [
  '---',
  'id: T-0130',
  'form: ship',
  '---',
  '',
  '## Goal',
  '',
  'Press one global hotkey, speak, and get a ticket in the inbox. No window to manage, no typing.',
  '',
  '## Decisions',
  '',
  '- Windows dictation (Win+H) is the speech engine; Drey only opens the capture window and focuses it.',
  '- The first sentence becomes the title; the rest stays in the description.',
  '',
  '## Constraints',
  '',
  '- Nothing leaves the machine.',
  '- The hotkey is configurable (ADR-0073).',
  '',
  '## Open questions',
  '',
  '- How many parts does this need? Asked in Mission Control.',
  '',
  '## Acceptance criteria',
  '',
  '- [ ] Hotkey raises Drey and opens the capture window with the caret in it',
  '- [ ] A spoken sentence ends up as one inbox ticket',
  '- [ ] Escape closes the window without creating anything',
  '',
  '## Plan',
  '',
  '### Parts',
  '',
  '- Capture hotkey and window',
  '- Dictation hand-off (Win+H)',
  '- Ticket from transcript',
  '',
].join('\n');

/** 5b: who edited which decision since the model's last turn. */
export const PAD_PLAN_130 = {
  ok: true,
  version: 7,
  edits: 1,
  summary: null,
  marks: [
    { no: 1, text: 'Windows dictation (Win+H) is the speech engine; Drey only opens the capture window and focuses it.', by: 'model' },
    { no: 2, text: 'The first sentence becomes the title; the rest stays in the description.', by: 'you' },
  ],
};

/** 5b: the question open on T-0130, in place of the phone sample's pushback. */
export const PAD_SHAPE_QUESTION = {
  kind: 'question',
  phase: 'plan',
  ticketId: 'T-0130',
  title: 'Voice capture for tickets',
  summary: 'How many parts does this need?',
  runId: 'run-paul',
  shaped: {
    question: 'How many parts does this need?',
    context: null,
    where: null,
    why: null,
    recommended: 1,
    recommendationWhy: null,
    options: [
      { n: 1, label: '3 parts', consequence: 'hotkey and window, dictation hand-off, ticket from transcript' },
      { n: 2, label: 'One ticket', consequence: 'about 2 days of work for one builder' },
    ],
  },
};

/** 5b / 5c: the board with Paul as T-0130's worker (the Worker row); the phone's board keeps its card as it was. */
export const PAD_BOARD = {
  ...BOARD,
  columns: BOARD.columns.map((column) => ({
    ...column,
    tickets: column.tickets.map((t) => (t.id === 'T-0130' ? { ...t, meta: { ...t.meta, persona: 'paul' } } : t)),
  })),
};

/** 5c: the three parts as the board words them: when each starts, and why it is a part. */
export const PAD_PARTS_130 = {
  ...PARTS_130,
  parts: PARTS_130.parts.map((part, i) => ({
    ...part,
    reason: ['Mod+Alt+T, focus handling', 'blocked-by P1', 'title from the first sentence'][i]!,
    start: ['starts first', 'after P1', 'after P2'][i]!,
    flow: ['Plan', 'Build', 'Review', 'Test'].map((title) => ({ phase: title.toLowerCase(), title, persona: title === 'Build' ? part.persona : null, inserted: false, skipped: false, notify: false })),
  })),
};

/** 5h: T-0121 as it reads at the review: a finished build with its Verification and a three-chapter walkthrough. */
const PAD_COST_121 = [
  '- {phase: plan, persona: paul, model: Claude sonnet, tokens: 21k, dauer: 4m, cost: 0.34, ausgang: done}',
  '- {phase: build, persona: ben, model: Claude sonnet, tokens: 52k, dauer: 9m, cost: 0.86, ausgang: done}',
  '- {phase: review, persona: ralf, model: Claude sonnet, tokens: 0, dauer: 0m, cost: 0, ausgang: done}',
].join('\n');

PAD_TICKET_TEXT['T-0121'] = [
  '---',
  'id: T-0121',
  '---',
  '',
  '## Goal',
  '',
  'Drag headings in the Outline panel to reorder a note. The text under a heading is part of the move.',
  '',
  '## Verification',
  '',
  'Tested on 2026-11-06 by Tessa',
  '',
  '- [x] Dragging a heading moves its whole section',
  '- [x] Undo restores it in one step',
  '- [x] Dropping a heading on itself does nothing',
  '- [x] The tree and the buffer stay in step',
  '',
  '### Video',
  '',
  '![](../videos/t-0121.webm)',
  '',
  '- 0:06 Drag a heading',
  '- 0:21 Undo once',
  '- 0:35 Last heading',
  '',
  '## Verlauf',
  '',
  PAD_COST_121,
  '',
].join('\n');

/** 5h: a patch of one hunk as the board draws it, then the lines that make up the file's count. */
const padPatch = (head: string[], add: number, del: number, at: number): string =>
  [
    ...head,
    `@@ -${at + 20},${del} +${at + 20},${add} @@`,
    ...Array.from({ length: del }, (_, i) => `-  legacy${i}();`),
    ...Array.from({ length: add }, (_, i) => `+  next${i}();`),
  ].join('\n');

/** 5h: the diff route's answer for T-0121: drag.ts (+84 −6, the board's hunk first), tree.ts, drag.spec.ts. */
export const PAD_DIFF_121 = {
  truncated: false,
  files: [
    {
      status: 'M',
      path: 'plugins/outline/renderer/drag.ts',
      patch: padPatch(
        [
          '@@ -41,7 +41,12 @@ function onDrop',
          ' function onDrop(event: DragEvent, tree: OutlineTree): void {',
          '   const target = tree.nodeAt(event.clientY);',
          '-  tree.moveHeading(source, target);',
          '+  const range = tree.sectionRange(source);',
          '+  if (range === null) { return; }',
          '+  tree.moveRange(range, target, { withBody: !event.altKey });',
          '   view.dispatch({ effects: refresh.of(null) });',
          ' }',
        ],
        81,
        5,
        60,
      ),
    },
    { status: 'M', path: 'plugins/outline/renderer/tree.ts', patch: padPatch([], 22, 3, 10) },
    { status: 'A', path: 'plugins/outline/renderer/drag.spec.ts', patch: ['@@ -0,0 +1,61 @@', ...Array.from({ length: 61 }, (_, i) => `+  it('case ${i}', () => {});`)].join('\n') },
  ],
};

/** 5c: the estimate the board's first part shows. */
export const PAD_ESTIMATES: Record<string, unknown> = {
  ...ESTIMATES,
  'build/ben': estimate('build', 'ben', 'qwen3-coder', 1.45, 1.1, 1.8),
};

/** 5i: the flow of T-0130's third part as the desk answers it before Paul's draft (the board's sample says part 3 whichever part is opened). */
const flowStep = (index: number, phase: string, title: string, extra: Record<string, unknown>) => ({
  index,
  phase,
  title,
  state: 'future',
  inserted: false,
  skipped: false,
  moved: false,
  notify: false,
  persona: null,
  pinned: false,
  model: null,
  owner: false,
  locked: false,
  ...extra,
});
const FLOW_BASE_STEPS = [
  flowStep(1, 'build', 'Build', { persona: 'ben', pinned: true, model: 'opus' }),
  flowStep(2, 'review', 'Review', { persona: 'ralf', model: 'sonnet' }),
  flowStep(3, 'verify', 'Verify', { persona: 'tessa', model: 'sonnet' }),
  flowStep(4, 'accept', 'Accept', { owner: true }),
];
export const PAD_FLOW_130 = {
  ok: true,
  ticket: 'T-0130',
  title: 'Voice capture for tickets',
  scope: { kind: 'part', index: 2, title: 'Ticket from transcript' },
  chain: [],
  saved: [],
  steps: FLOW_BASE_STEPS,
  phases: [
    { id: 'build', title: 'Build' },
    { id: 'review', title: 'Review' },
    { id: 'security', title: 'Security' },
    { id: 'verify', title: 'Verify' },
    { id: 'accept', title: 'Accept' },
  ],
  personas: [
    { id: 'ralf', kind: 'agent', title: 'Ralf', color: 'var(--accent-peach)', model: 'sonnet' },
    { id: 'ben', kind: 'agent', title: 'Ben', color: 'var(--accent)', model: 'opus' },
    { id: 'paul', kind: 'agent', title: 'Paul', color: 'var(--accent-peach)', model: 'sonnet' },
    { id: 'tessa', kind: 'agent', title: 'Tessa', color: 'var(--ok)', model: 'sonnet' },
    { id: 'you', kind: 'human', title: 'You', color: 'var(--text)', model: '' },
  ],
  readOnly: null,
  reason: null,
};

/** 5i: Paul's draft (what `POST /api/tickets/T-0130/flow-draft` answers): a security pass by Ralf after the review, with a card for the owner. */
export const PAD_FLOW_130_DRAFT = {
  ...PAD_FLOW_130,
  chain: ['insert security after review'],
  steps: [
    FLOW_BASE_STEPS[0],
    FLOW_BASE_STEPS[1],
    flowStep(3, 'security', 'Security', { inserted: true, persona: 'ralf', pinned: true, model: 'sonnet', notify: true }),
    { ...FLOW_BASE_STEPS[2], index: 4 },
    { ...FLOW_BASE_STEPS[3], index: 5 },
  ],
  reason: 'Part 3 touches the command parser, so I added a security pass by Ralf after the review. You would be told when it is done.',
};

/** 5d: the iPad's crew list: Paul runs a two-entry pool (the local model first, Claude Code as overflow). */
export const PAD_PERSONAS = PERSONAS.map((p) => (p.id === 'paul' ? { ...p, model: 'qwen3-coder', pool: ['opencode', 'claude-code'] } : p));

/** 5d: what the persona page asks besides the list: no proposals, an empty thread, twelve memory entries. */
export const PAD_PERSONA_IMPROVEMENTS = { persona: null, proposals: [], openCount: 0, frictionCount: 0 };
export const PAD_PERSONA_THREAD = { messages: [] };
export const PAD_PERSONA_MEMORY = {
  entries: Array.from({ length: 12 }, (_, i) => ({ text: `Memory entry ${i + 1}`, pinned: i === 0 })),
};
