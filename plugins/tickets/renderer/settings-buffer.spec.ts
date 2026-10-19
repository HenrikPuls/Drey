import { describe, expect, it } from 'vitest';
import type { PipelinePhase } from '../shared/tickets';
import {
  addColumn,
  bufferDirty,
  editColumn,
  mergeBuffer,
  moveColumn,
  promptOptions,
  removeColumn,
  startBuffer,
  toBatch,
  type ColumnsState,
} from './settings-buffer';

const phase = (id: string, title: string, extra: Partial<PipelinePhase> = {}): PipelinePhase => ({
  id,
  title,
  wip: null,
  claim: false,
  handover: 'manual',
  worker: null,
  model: null,
  workers: 1,
  prompt: null,
  maxRed: null,
  tokenBudget: null,
  ci: null,
  audit: null,
  semantic: false,
  ...extra,
});

const STATE: ColumnsState = {
  pipeline: [
    phase('inbox', 'Inbox'),
    phase('prioritized', 'Prioritized'),
    phase('build', 'Build', { handover: 'agent build-default', worker: 'opencode', workers: 2 }),
    phase('review', 'Review'),
    phase('done', 'Done', { handover: 'none' }),
  ],
  folders: { root: 'X:/tickets', moves: [] },
  promptRefs: ['build-default', 'plan-heavy'],
  defaultWorker: 'opencode',
  counts: { inbox: 1, prioritized: 0, build: 3, review: 0, done: 2 },
};

describe('the buffer basics (T-0043)', () => {
  it('starts clean and flushes nothing', () => {
    const buf = startBuffer(STATE);
    expect(bufferDirty(buf)).toBe(false);
    expect(toBatch(buf)).toBeNull();
    expect(buf.order).toEqual(['inbox', 'prioritized', 'build', 'review', 'done']);
  });

  it('buffers a field edit as a patch against the base value', () => {
    const buf = startBuffer(STATE);
    editColumn(buf, 'build', { workers: 4, model: 'zai/glm-5.3' });
    expect(toBatch(buf)).toEqual({
      order: STATE.pipeline.map((p) => p.id),
      add: [],
      remove: [],
      patch: { build: { workers: 4, model: 'zai/glm-5.3' } },
    });
  });

  it('a value set back to base omits the key entirely (patch semantics)', () => {
    const buf = startBuffer(STATE);
    editColumn(buf, 'build', { workers: 5 });
    expect(bufferDirty(buf)).toBe(true);
    editColumn(buf, 'build', { workers: 2 }); // back to the base value
    expect(toBatch(buf)).toBeNull();
    expect(bufferDirty(buf)).toBe(false);
  });

  it('clearing a set value rides as null, and prompt "" follows the handover', () => {
    const withPool: ColumnsState = {
      ...STATE,
      pipeline: STATE.pipeline.map((p) =>
        p.id === 'build' ? { ...p, model: 'zai/glm-5.3', prompt: 'plan-heavy' } : p,
      ),
    };
    const buf = startBuffer(withPool);
    editColumn(buf, 'build', { model: null, workers: null, prompt: '' });
    expect(toBatch(buf)?.patch['build']).toEqual({ model: null, workers: null, prompt: null });
    editColumn(buf, 'review', { worker: 'opencode', prompt: 'plan-heavy' });
    const batch = toBatch(buf);
    expect(batch?.patch['review']).toEqual({ worker: 'opencode', prompt: 'plan-heavy' });
    // Clearing the worker on a staffed column is the manual flip: the
    // worker and everything the pool set ride as nulls.
    editColumn(buf, 'build', { worker: '' });
    expect(toBatch(buf)?.patch['build']).toEqual({ worker: null, model: null, workers: null, prompt: null });
    // Clearing keys a column never had changes nothing (back to base).
    const bare = startBuffer(STATE);
    editColumn(bare, 'review', { model: null, prompt: '' });
    expect(toBatch(bare)?.patch['review']).toBeUndefined();
  });

  it('ignores edits of unknown columns', () => {
    const buf = startBuffer(STATE);
    editColumn(buf, 'nope', { workers: 2 });
    expect(toBatch(buf)).toBeNull();
  });
});

describe('addColumn / removeColumn (T-0043)', () => {
  it('appends a new column before the terminal, manual; edits ride the same patch path', () => {
    const buf = startBuffer(STATE);
    addColumn(buf, 'qa', 'QA');
    expect(buf.order).toEqual(['inbox', 'prioritized', 'build', 'review', 'qa', 'done']);
    expect(toBatch(buf)).toEqual({
      order: [...STATE.pipeline.slice(0, 4).map((p) => p.id), 'qa', 'done'],
      add: [{ id: 'qa', title: 'QA' }],
      remove: [],
      patch: {},
    });
    editColumn(buf, 'qa', { worker: 'opencode', workers: 2 });
    expect(toBatch(buf)?.patch['qa']).toEqual({ worker: 'opencode', workers: 2 });
    expect(toBatch(buf)?.add).toEqual([{ id: 'qa', title: 'QA' }]);
  });

  it('refuses a duplicate or an add onto a one-column pipeline', () => {
    const buf = startBuffer(STATE);
    addColumn(buf, 'qa', 'QA');
    addColumn(buf, 'qa', 'QA again');
    expect(buf.added.get('qa')).toBe('QA');
    const single = startBuffer({
      ...STATE,
      pipeline: [phase('inbox', 'Inbox')],
      counts: { inbox: 0 },
    });
    addColumn(single, 'qa', 'QA');
    expect(single.order).toEqual(['inbox']);
    expect(toBatch(single)).toBeNull();
  });

  it('removes an empty middle column into the batch', () => {
    const buf = startBuffer(STATE);
    expect(removeColumn(buf, 'review')).toEqual({ ok: true });
    expect(buf.order).toEqual(['inbox', 'prioritized', 'build', 'done']);
    expect(toBatch(buf)).toEqual({
      order: ['inbox', 'prioritized', 'build', 'done'],
      add: [],
      remove: ['review'],
      patch: {},
    });
  });

  it('refuses the capture target, the terminal and a column that holds tickets', () => {
    const buf = startBuffer(STATE);
    expect(removeColumn(buf, 'inbox')).toEqual({
      ok: false,
      reason: '"Inbox" is the first column — the capture target for new tickets',
    });
    expect(removeColumn(buf, 'done')).toEqual({
      ok: false,
      reason: '"Done" is the last column — the terminal',
    });
    expect(removeColumn(buf, 'build')).toEqual({
      ok: false,
      reason: '"Build" still holds 3 tickets — move or archive them first',
    });
    expect(buf.order).toEqual(STATE.pipeline.map((p) => p.id));
    expect(toBatch(buf)).toBeNull();
  });

  it('undoing this session\'s add leaves nothing behind', () => {
    const buf = startBuffer(STATE);
    addColumn(buf, 'qa', 'QA');
    editColumn(buf, 'qa', { workers: 3 });
    expect(removeColumn(buf, 'qa')).toEqual({ ok: true });
    expect(buf.order).toEqual(STATE.pipeline.map((p) => p.id));
    expect(toBatch(buf)).toBeNull();
  });

  it('drops the field patch of a removed column', () => {
    const buf = startBuffer(STATE);
    editColumn(buf, 'review', { workers: 2 });
    expect(removeColumn(buf, 'review')).toEqual({ ok: true });
    expect(toBatch(buf)).toEqual({
      order: ['inbox', 'prioritized', 'build', 'done'],
      add: [],
      remove: ['review'],
      patch: {},
    });
  });
});

describe('moveColumn (T-0043)', () => {
  it('moves a middle row anywhere between the pinned ends', () => {
    const buf = startBuffer(STATE);
    expect(moveColumn(buf, 1, 3)).toBe(true);
    expect(buf.order).toEqual(['inbox', 'build', 'review', 'prioritized', 'done']);
    expect(toBatch(buf)).toEqual({
      order: ['inbox', 'build', 'review', 'prioritized', 'done'],
      add: [],
      remove: [],
      patch: {},
    });
  });

  it('refuses the ends and no-ops (canMove rules)', () => {
    const buf = startBuffer(STATE);
    expect(moveColumn(buf, 0, 2)).toBe(false);
    expect(moveColumn(buf, 4, 2)).toBe(false);
    expect(moveColumn(buf, 2, 0)).toBe(false);
    expect(moveColumn(buf, 2, 4)).toBe(false);
    expect(moveColumn(buf, 2, 2)).toBe(false);
    expect(buf.order).toEqual(STATE.pipeline.map((p) => p.id));
    expect(toBatch(buf)).toBeNull();
  });
});

describe('mergeBuffer (T-0043)', () => {
  it('re-anchors base data and keeps buffered edits', () => {
    const buf = startBuffer(STATE);
    editColumn(buf, 'review', { workers: 2 });
    addColumn(buf, 'qa', 'QA');
    expect(removeColumn(buf, 'prioritized')).toEqual({ ok: true });
    mergeBuffer(buf, {
      ...STATE,
      counts: { inbox: 2, prioritized: 0, build: 0, review: 1, done: 2 },
      promptRefs: ['build-default', 'plan-heavy', 'qa-heavy'],
    });
    expect(buf.base.counts['build']).toBe(0);
    expect(buf.base.promptRefs).toContain('qa-heavy');
    expect(buf.order).toEqual(['inbox', 'build', 'review', 'qa', 'done']);
    expect(toBatch(buf)).toEqual({
      order: ['inbox', 'build', 'review', 'qa', 'done'],
      add: [{ id: 'qa', title: 'QA' }],
      remove: ['prioritized'],
      patch: { review: { workers: 2 } },
    });
  });

  it('drops removals and patches of phases that vanished from disk', () => {
    const buf = startBuffer(STATE);
    editColumn(buf, 'review', { workers: 2 });
    expect(removeColumn(buf, 'prioritized')).toEqual({ ok: true });
    // Someone else removed both while the dialog was open.
    mergeBuffer(buf, {
      ...STATE,
      pipeline: STATE.pipeline.filter((p) => p.id !== 'review' && p.id !== 'prioritized'),
      counts: { inbox: 1, build: 3, done: 2 },
    });
    expect(buf.order).toEqual(['inbox', 'build', 'done']);
    expect(toBatch(buf)).toBeNull();
    expect(buf.removed).toEqual(new Set());
  });

  it('slots phases unknown to the buffer in before the terminal, fresh order among themselves', () => {
    const buf = startBuffer(STATE);
    // The disk gains audit (before done) and staging (before audit).
    mergeBuffer(buf, {
      ...STATE,
      pipeline: [
        ...STATE.pipeline.slice(0, 4),
        phase('staging', 'Staging'),
        phase('audit', 'Audit'),
        STATE.pipeline[4]!,
      ],
      counts: { ...STATE.counts, staging: 0, audit: 0 },
    });
    expect(buf.order).toEqual(['inbox', 'prioritized', 'build', 'review', 'staging', 'audit', 'done']);
  });

  it('keeps a buffered removal out of the re-slotted unknowns', () => {
    const buf = startBuffer(STATE);
    expect(removeColumn(buf, 'review')).toEqual({ ok: true });
    mergeBuffer(buf, STATE); // review still on disk
    expect(buf.order).toEqual(['inbox', 'prioritized', 'build', 'done']);
    expect(toBatch(buf)?.remove).toEqual(['review']);
  });
});

describe('promptOptions (T-0043)', () => {
  const REFS = ['build-default', 'plan-heavy'];

  it('the default option names the handover\'s ref, (none) without one', () => {
    expect(promptOptions(null, 'build-default', REFS)).toEqual([
      { value: '', label: 'Handover (build-default)', missing: false },
      { value: 'build-default', label: 'build-default', missing: false },
      { value: 'plan-heavy', label: 'plan-heavy', missing: false },
    ]);
    expect(promptOptions(null, null, ['plan-heavy'])).toEqual([
      { value: '', label: '(none)', missing: false },
      { value: 'plan-heavy', label: 'plan-heavy', missing: false },
    ]);
  });

  it('marks a missing handover ref on the default label', () => {
    const options = promptOptions(null, 'gone-ref', REFS);
    expect(options[0]).toEqual({ value: '', label: 'Handover (gone-ref, file missing)', missing: true });
    expect(options.slice(1).map((o) => o.value)).toEqual(['build-default', 'plan-heavy']);
  });

  it('shows an explicit ref whose file is missing as a marked extra entry', () => {
    const options = promptOptions('gone-ref', 'build-default', REFS);
    expect(options.find((o) => o.value === 'gone-ref')).toEqual({
      value: 'gone-ref',
      label: 'gone-ref (file missing)',
      missing: true,
    });
    // An explicit ref with a file is just one of the refs — no duplicate.
    expect(promptOptions('plan-heavy', 'build-default', REFS).filter((o) => o.value === 'plan-heavy')).toHaveLength(1);
  });

  it('distinguishes an explicit prompt equal to the handover ref from following it', () => {
    const options = promptOptions('build-default', 'build-default', REFS);
    expect(options[0]).toEqual({ value: '', label: 'Handover (build-default)', missing: false });
    expect(options.filter((o) => o.value === 'build-default')).toHaveLength(1);
  });
});
