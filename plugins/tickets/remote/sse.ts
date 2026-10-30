/**
 * A Server-Sent Events parser for the phone client (req-66). The client
 * reads `/api/events` with `fetch` because EventSource cannot send the
 * bearer header; this turns the streamed text into events. Pure.
 */
export interface SseEvent {
  readonly event: string;
  readonly data: string;
}

export class SseParser {
  private buffer = '';

  /** Feeds a chunk; returns the events it completed. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk.replace(/\r\n?/g, '\n');
    const events: SseEvent[] = [];
    let end = this.buffer.indexOf('\n\n');
    while (end >= 0) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      let event = 'message';
      const data: string[] = [];
      let fields = 0;
      for (const line of block.split('\n')) {
        if (line === '' || line.startsWith(':')) {
          continue;
        }
        const colon = line.indexOf(':');
        const name = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (name === 'event') {
          event = value;
          fields++;
        } else if (name === 'data') {
          data.push(value);
          fields++;
        }
      }
      if (fields > 0) {
        events.push({ event, data: data.join('\n') });
      }
      end = this.buffer.indexOf('\n\n');
    }
    return events;
  }
}
