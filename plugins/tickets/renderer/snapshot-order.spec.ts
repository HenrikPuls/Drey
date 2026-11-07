import { describe, expect, it } from 'vitest';
import { createSnapshotOrder } from './snapshot-order';

function deferred(): { promise: Promise<string>; answer: (value: string) => void } {
  let answer: (value: string) => void = () => undefined;
  const promise = new Promise<string>((resolve) => {
    answer = resolve;
  });
  return { promise, answer };
}

describe('the fleet snapshots in order (D-49)', () => {
  it('a push after the question wins over the older reply', async () => {
    const order = createSnapshotOrder();
    const shown: string[] = [];
    const reply = deferred();
    const pulled = order.pull(() => reply.promise, (value) => shown.push(value));
    order.push(() => shown.push('pushed: two live runs'));
    reply.answer('asked earlier: no runs');
    await pulled;
    expect(shown).toEqual(['pushed: two live runs']);
  });

  it('a reply to a question asked after the push applies', async () => {
    const order = createSnapshotOrder();
    const shown: string[] = [];
    order.push(() => shown.push('pushed'));
    await order.pull(() => Promise.resolve('asked later'), (value) => shown.push(value));
    expect(shown).toEqual(['pushed', 'asked later']);
  });

  it('of two questions the later one stands, whichever reply comes first', async () => {
    const order = createSnapshotOrder();
    const shown: string[] = [];
    const first = deferred();
    const second = deferred();
    const pulls = [order.pull(() => first.promise, (value) => shown.push(value)), order.pull(() => second.promise, (value) => shown.push(value))];
    second.answer('second');
    await pulls[1];
    first.answer('first');
    await pulls[0];
    expect(shown).toEqual(['second']);
  });

  it('a failed question changes nothing and passes the failure on', async () => {
    const order = createSnapshotOrder();
    const shown: string[] = [];
    await expect(order.pull(() => Promise.reject(new Error('no engine')), (value: string) => shown.push(value))).rejects.toThrow('no engine');
    await order.pull(() => Promise.resolve('next'), (value) => shown.push(value));
    expect(shown).toEqual(['next']);
  });
});
