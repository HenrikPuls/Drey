import { describe, expect, it } from 'vitest';
import { SseParser } from './sse';

/** req-66: the event-stream parser the phone client reads `/api/events` with. */

describe('SseParser', () => {
  it('completes events across chunks and skips comments and retry lines', () => {
    const parser = new SseParser();
    expect(parser.push('retry: 3000\n\n: ping\n\nevent: bo')).toEqual([]);
    expect(parser.push('ard\ndata: {}\n\nevent: fleet\r\ndata: a\r\ndata: b\r\n\r\n')).toEqual([
      { event: 'board', data: '{}' },
      { event: 'fleet', data: 'a\nb' },
    ]);
  });

  it('names an event without an event field "message"', () => {
    expect(new SseParser().push('data:x\n\n')).toEqual([{ event: 'message', data: 'x' }]);
  });
});
