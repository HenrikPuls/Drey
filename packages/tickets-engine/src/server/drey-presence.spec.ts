import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DreyPresence } from './drey-presence';

describe('DreyPresence (req-110)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires once the last stream has been gone for the grace span', () => {
    const gone = vi.fn();
    const presence = new DreyPresence(gone, 1_000);
    const close = presence.attach();
    close();
    vi.advanceTimersByTime(999);
    expect(gone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it('a reconnect inside the grace span is not a quit', () => {
    const gone = vi.fn();
    const presence = new DreyPresence(gone, 1_000);
    presence.attach()();
    vi.advanceTimersByTime(500);
    const again = presence.attach();
    vi.advanceTimersByTime(2_000);
    expect(gone).not.toHaveBeenCalled();
    again();
    vi.advanceTimersByTime(1_000);
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it('a second Drey instance still subscribed keeps the runner', () => {
    const gone = vi.fn();
    const presence = new DreyPresence(gone, 1_000);
    const first = presence.attach();
    const second = presence.attach();
    first();
    vi.advanceTimersByTime(5_000);
    expect(gone).not.toHaveBeenCalled();
    expect(presence.connected).toBe(1);
    second();
    vi.advanceTimersByTime(1_000);
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it('closing a stream twice counts once', () => {
    const gone = vi.fn();
    const presence = new DreyPresence(gone, 100);
    const a = presence.attach();
    const b = presence.attach();
    a();
    a();
    expect(presence.connected).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(gone).not.toHaveBeenCalled();
    b();
    vi.advanceTimersByTime(100);
    expect(gone).toHaveBeenCalledTimes(1);
  });
});
