/**
 * Specs for the SSE frame parser (E5b): frames split across chunks,
 * several frames in one buffer, comment lines, an ignored `retry`
 * field, CRLF line endings, and multi-line `data:`.
 */
import { describe, expect, it } from 'vitest';
import { SseParser } from './sse';

describe('SseParser', () => {
  it('parses one complete frame', () => {
    const parser = new SseParser();
    expect(parser.push('event: board\ndata: {}\n\n')).toEqual([{ event: 'board', data: '{}' }]);
  });

  it('defaults the event name to message', () => {
    const parser = new SseParser();
    expect(parser.push('data: hello\n\n')).toEqual([{ event: 'message', data: 'hello' }]);
  });

  it('parses several frames from one buffer', () => {
    const parser = new SseParser();
    const chunk = 'event: board\ndata: {}\n\nevent: fleet\ndata: {"runs":[]}\n\n';
    expect(parser.push(chunk)).toEqual([
      { event: 'board', data: '{}' },
      { event: 'fleet', data: '{"runs":[]}' },
    ]);
  });

  it('holds a frame split across chunks until it completes', () => {
    const parser = new SseParser();
    expect(parser.push('event: cha')).toEqual([]);
    expect(parser.push('t\ndata: {"file":"f.md","event":{"kind":"text","text":"Hel')).toEqual([]);
    expect(parser.push('lo"}}\n\n')).toEqual([{ event: 'chat', data: '{"file":"f.md","event":{"kind":"text","text":"Hello"}}' }]);
  });

  it('skips comment lines and ignores the retry field', () => {
    const parser = new SseParser();
    const chunk = ': keep-alive\nretry: 3000\nevent: board\ndata: {}\n\n: ping\n\n';
    expect(parser.push(chunk)).toEqual([{ event: 'board', data: '{}' }]);
  });

  it('emits nothing for a block of only comments', () => {
    const parser = new SseParser();
    expect(parser.push(': just a comment\n\n')).toEqual([]);
  });

  it('emits nothing for a block of only unknown fields', () => {
    const parser = new SseParser();
    expect(parser.push('id: 42\n\n')).toEqual([]);
  });

  it('normalizes CRLF and lone CR line endings', () => {
    const parser = new SseParser();
    expect(parser.push('event: board\r\ndata: {}\r\n\r\n')).toEqual([{ event: 'board', data: '{}' }]);
    const other = new SseParser();
    expect(other.push('event: board\rdata: {}\r\r')).toEqual([{ event: 'board', data: '{}' }]);
  });

  it('joins multi-line data with newlines', () => {
    const parser = new SseParser();
    expect(parser.push('event: chat\ndata: {"a":1,\ndata: "b":2}\n\n')).toEqual([
      { event: 'chat', data: '{"a":1,\n"b":2}' },
    ]);
  });

  it('treats a field without a colon as a flag with an empty value', () => {
    const parser = new SseParser();
    expect(parser.push('event\ndata: x\n\n')).toEqual([{ event: '', data: 'x' }]);
  });
});
