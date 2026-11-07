import { describe, expect, it } from 'vitest';
import type { FleetSnapshot } from '../../../packages/tickets-engine/src/services/fleet-client';
import type { RunInfo } from '../../../packages/tickets-engine/src/fleet/protocol';
import { createFleetSnapshotSender, type FleetSnapshotSource } from './fleet-snapshot';

const run = (id: string): RunInfo => ({ id, state: 'running' }) as unknown as RunInfo;
const chain = (master: string): FleetSnapshot['chain'] => ({ master }) as unknown as FleetSnapshot['chain'];

/** A source whose reads the spec answers by hand, in the order it chooses. */
function heldSource(): FleetSnapshotSource & { answer(runs: readonly RunInfo[], status: FleetSnapshot['chain']): void; reads(): number } {
  const pending: { resolve: (value: FleetSnapshot) => void; read: Promise<FleetSnapshot> }[] = [];
  const nextRead = (): Promise<FleetSnapshot> => {
    let resolve!: (value: FleetSnapshot) => void;
    const read = new Promise<FleetSnapshot>((r) => {
      resolve = r;
    });
    pending.push({ resolve, read });
    return read;
  };
  let current: Promise<FleetSnapshot> | null = null;
  let count = 0;
  return {
    runs: async () => {
      count += 1;
      current = nextRead();
      return (await current).runs;
    },
    chainStatus: async () => (await current!).chain,
    answer: (runs, status) => pending.shift()!.resolve({ runs, chain: status }),
    reads: () => count,
  };
}

describe('the fleet snapshot sender (D-35)', () => {
  it('sends the runs and the chain the engine reports', async () => {
    const sent: FleetSnapshot[] = [];
    const send = createFleetSnapshotSender(
      { runs: async () => [run('r1')], chainStatus: async () => chain('run') },
      (snapshot) => sent.push(snapshot),
    );
    await send();
    expect(sent).toEqual([{ runs: [run('r1')], chain: chain('run') }]);
  });

  it('sends a dead runner as such: no chain, the runs on disk', async () => {
    const sent: FleetSnapshot[] = [];
    const send = createFleetSnapshotSender({ runs: async () => [run('old')], chainStatus: async () => null }, (s) => sent.push(s));
    await send();
    expect(sent).toEqual([{ runs: [run('old')], chain: null }]);
  });

  it('a signal during a read reads once more, so the newest state is what stays', async () => {
    const source = heldSource();
    const sent: FleetSnapshot[] = [];
    const send = createFleetSnapshotSender(source, (s) => sent.push(s));
    const first = send();
    const second = send();
    const third = send();
    source.answer([run('old')], chain('halted'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(source.reads()).toBe(2);
    source.answer([run('new')], chain('run'));
    await Promise.all([first, second, third]);
    expect(sent.map((s) => s.runs[0]!.id)).toEqual(['old', 'new']);
    expect(source.reads()).toBe(2);
  });

  it('a failed read keeps what the renderer has instead of sending an empty fleet', async () => {
    const sent: FleetSnapshot[] = [];
    const failures: unknown[] = [];
    const send = createFleetSnapshotSender(
      { runs: async () => { throw new Error('the engine is restarting'); }, chainStatus: async () => chain('run') },
      (s) => sent.push(s),
      (error) => failures.push(error),
    );
    await send();
    expect(sent).toEqual([]);
    expect(failures).toHaveLength(1);
  });
});
