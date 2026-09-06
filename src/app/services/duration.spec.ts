import { formatDuration, formatThinking, formatTook } from '../../../shared/duration';

describe('formatDuration', () => {
  it('shows whole seconds below a minute', () => {
    expect(formatDuration(8_400)).toBe('8s');
    expect(formatDuration(59_400)).toBe('59s');
  });

  it('never shows 0s -- a finished task always took at least a moment', () => {
    expect(formatDuration(0)).toBe('1s');
    expect(formatDuration(120)).toBe('1s');
  });

  it('switches to minutes with zero-padded seconds', () => {
    expect(formatDuration(64_000)).toBe('1m 04s');
    expect(formatDuration(750_000)).toBe('12m 30s');
    expect(formatDuration(120_000)).toBe('2m 00s');
  });

  it('labels the two states the panel shows', () => {
    expect(formatThinking(8_000)).toBe('thinking 8s');
    expect(formatTook(64_000)).toBe('took 1m 04s');
  });
});
