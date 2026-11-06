import { describe, expect, it, vi } from 'vitest';
import { settleCommitStepsOnFleet } from './settle-on-fleet';

describe('settleCommitStepsOnFleet', () => {
  function setup(settle: () => Promise<void>) {
    let fire: (what: string) => void = () => undefined;
    const off = vi.fn();
    const log = vi.fn();
    const stop = settleCommitStepsOnFleet((listener) => {
      fire = listener;
      return off;
    }, settle, log);
    return { fire: (what: string) => fire(what), off, log, stop };
  }

  it('settles on a fleet change and on a board change (D-32: the release lands after the run), on nothing else', () => {
    const settle = vi.fn(() => Promise.resolve());
    const { fire } = setup(settle);
    fire('remote');
    fire('chat');
    expect(settle).not.toHaveBeenCalled();
    fire('fleet');
    expect(settle).toHaveBeenCalledTimes(1);
    fire('board');
    expect(settle).toHaveBeenCalledTimes(2);
  });

  it('logs a failure instead of leaving it unhandled', async () => {
    const { fire, log } = setup(() => Promise.reject(new Error('dk refused')));
    fire('fleet');
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('commit step settling failed: dk refused', 'warn'));
  });

  it('hands back the way to stop', () => {
    const { stop, off } = setup(() => Promise.resolve());
    stop();
    expect(off).toHaveBeenCalledTimes(1);
  });
});
