import { describe, expect, it } from 'vitest';
import { createMessageQueue, readyToFlush, type QueuedMessage } from './message-queue';

/**
 * The busy worker's message queue (req-75 W4c): order is kept, one head
 * leaves at a time, storage round-trips and drops anything malformed.
 */
describe('createMessageQueue', () => {
  it('adds in order, lists in order, heads the first', () => {
    const queue = createMessageQueue();
    queue.add('first', [], '2026-10-31T10:00:00Z');
    queue.add('second', [], '2026-10-31T10:00:01Z');
    expect(queue.list().map((m) => m.text)).toEqual(['first', 'second']);
    expect(queue.head()?.text).toBe('first');
  });

  it('add returns the stored entry with id, timestamp and a copy of the attachments', () => {
    const queue = createMessageQueue();
    const paths = ['w/notes.md'];
    const entry = queue.add('look', paths, '2026-10-31T10:00:00Z');
    expect(entry.id).not.toBe('');
    expect(entry.at).toBe('2026-10-31T10:00:00Z');
    expect(entry.attachments).toEqual(['w/notes.md']);
    paths.push('w/other.md');
    expect(queue.list()[0]?.attachments).toEqual(['w/notes.md']);
  });

  it('head is null when the queue is empty, also after the last remove', () => {
    const queue = createMessageQueue();
    expect(queue.head()).toBeNull();
    const entry = queue.add('only', [], '2026-10-31T10:00:00Z');
    queue.remove(entry.id);
    expect(queue.head()).toBeNull();
    expect(queue.list()).toEqual([]);
  });

  it('edit rewrites the text in place; edit and remove of an unknown id do nothing', () => {
    const queue = createMessageQueue();
    const a = queue.add('a', [], '2026-10-31T10:00:00Z');
    const b = queue.add('b', [], '2026-10-31T10:00:01Z');
    queue.edit(a.id, 'a2');
    expect(queue.list().map((m) => m.text)).toEqual(['a2', 'b']);
    expect(() => queue.edit('nope', 'x')).not.toThrow();
    expect(() => queue.remove('nope')).not.toThrow();
    expect(queue.list().map((m) => m.text)).toEqual(['a2', 'b']);
  });

  it('remove takes the entry the owner dismissed, order otherwise intact', () => {
    const queue = createMessageQueue();
    const a = queue.add('a', [], '2026-10-31T10:00:00Z');
    const b = queue.add('b', [], '2026-10-31T10:00:01Z');
    queue.remove(a.id);
    expect(queue.list().map((m) => m.text)).toEqual(['b']);
  });

  it('toJSON round-trips through restore with everything kept', () => {
    const queue = createMessageQueue();
    queue.add('hello', ['w/one.md', 'w/two.md'], '2026-10-31T10:00:00Z');
    queue.add('/clear', [], '2026-10-31T10:00:01Z');
    const restored = createMessageQueue(queue.toJSON());
    expect(restored.list()).toEqual(queue.list());
    // and it stays usable: edit and head work on restored ids
    restored.edit(restored.head()!.id, 'hello again');
    expect(restored.head()?.text).toBe('hello again');
  });

  it('restore drops malformed entries and keeps the valid ones', () => {
    const good: QueuedMessage = { id: 'q1', text: 'keep', attachments: [], at: '2026-10-31T10:00:00Z' };
    const bad: unknown = [
      good,
      { id: '', text: 'no id', attachments: [], at: 'x' }, // empty id
      { id: 'q2', text: 7, attachments: [], at: 'x' }, // text not a string
      { id: 'q3', text: 'ok', attachments: ['a.md', 3], at: 'x' }, // attachment not a string
      { id: 'q4', text: 'ok', attachments: [], at: '' }, // no timestamp
      { id: 'q5' }, // missing fields
      'not an object',
    ];
    const queue = createMessageQueue(bad);
    expect(queue.list()).toEqual([good]);
  });

  it('restore of a non-array, a broken string or undefined starts empty', () => {
    expect(createMessageQueue(undefined).list()).toEqual([]);
    expect(createMessageQueue(null).list()).toEqual([]);
    expect(createMessageQueue({ entries: [] }).list()).toEqual([]);
    expect(createMessageQueue('not json at all').list()).toEqual([]);
    expect(createMessageQueue('{"entries":[]}').list()).toEqual([]);
  });
});

describe('readyToFlush', () => {
  const run = (state: string, turn?: 'busy' | 'idle', waiting?: unknown | null): { state: string; turn?: 'busy' | 'idle'; waiting?: unknown | null } =>
    waiting === undefined ? { state, turn } : { state, turn, waiting };

  it('a live run standing idle with nothing waited on may flush', () => {
    expect(readyToFlush(run('running', 'idle', null))).toBe(true);
    expect(readyToFlush(run('starting', 'idle'))).toBe(true); // absent waiting counts as none
  });

  it('a busy turn never flushes — the worker is in the middle of it', () => {
    expect(readyToFlush(run('running', 'busy', null))).toBe(false);
  });

  it('a run that has not said which turn it is in does not flush', () => {
    expect(readyToFlush(run('running', undefined, null))).toBe(false);
  });

  it('a waiting run never flushes — the owner answers first', () => {
    expect(readyToFlush(run('running', 'idle', { kind: 'question' }))).toBe(false);
  });

  it('a run that is not live never flushes', () => {
    expect(readyToFlush(run('done', 'idle', null))).toBe(false);
    expect(readyToFlush(run('failed', 'idle', null))).toBe(false);
    expect(readyToFlush(run('detached', 'idle', null))).toBe(false);
    expect(readyToFlush(null)).toBe(false);
  });
});
