import { describe, expect, it } from 'vitest';
import type { ConversationTarget } from '../../../shared/plugin-api/renderer';
import { MODEL_TARGET, resolveViewDefault, segmentsOf } from './targets-model';

const empty = { id: null, title: '', messages: [] };

const target = (id: string, label: string, group?: string): ConversationTarget => ({
  id,
  label,
  ...(group !== undefined ? { group } : {}),
  thread: () => Promise.resolve(empty),
  send: () => Promise.resolve(empty),
  act: () => Promise.resolve(empty),
  newThread: () => Promise.resolve(empty),
});

describe('segmentsOf', () => {
  it('is only the model while nothing is registered', () => {
    expect(segmentsOf([]).map((s) => s.key)).toEqual([MODEL_TARGET]);
  });

  it('puts plain targets after the model and folds a group into one segment', () => {
    const segments = segmentsOf([
      target('t.mc', 'Mission Control'),
      target('t.paul', 'Paul', '1:1'),
      target('t.ben', 'Ben', '1:1'),
    ]);
    expect(segments.map((s) => [s.key, s.label])).toEqual([
      ['model', 'Model'],
      ['t.mc', 'Mission Control'],
      ['group:1:1', '1:1'],
    ]);
    expect(segments[2]?.targets.map((t) => t.id)).toEqual(['t.paul', 't.ben']);
  });
});

describe('resolveViewDefault', () => {
  it('reads no default as the model', () => {
    expect(resolveViewDefault(null, [])).toEqual({ kind: 'select', id: 'model' });
  });

  it('selects a registered default and waits for one that is not there yet', () => {
    expect(resolveViewDefault('t.mc', ['t.mc'])).toEqual({ kind: 'select', id: 't.mc' });
    expect(resolveViewDefault('t.mc', [])).toEqual({ kind: 'wait' });
  });
});
