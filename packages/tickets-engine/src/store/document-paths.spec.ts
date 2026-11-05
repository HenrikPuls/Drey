import { describe, expect, it } from 'vitest';
import { documentRelPath, idOfDocumentPath } from './document-paths';

describe('ticket document paths (E14-4c)', () => {
  it('maps a display id to the sharded checkout path and back', () => {
    expect(documentRelPath('T-0063')).toBe('tickets/t/0000/t-63/ticket.md');
    expect(documentRelPath('T-1500')).toBe('tickets/t/0001/t-1500/ticket.md');
    expect(idOfDocumentPath('tickets/t/0000/t-63/ticket.md')).toBe('T-0063');
    expect(idOfDocumentPath('tickets\\t\\0001\\t-1500\\ticket.md')).toBe('T-1500');
  });

  it('knows nothing else as a ticket document', () => {
    expect(documentRelPath('not-an-id')).toBeNull();
    expect(idOfDocumentPath('tickets/t/0000/t-63/comments/a.md')).toBeNull();
    expect(idOfDocumentPath('tickets/t/0009/t-63/ticket.md')).toBeNull();
    expect(idOfDocumentPath('notes/t/0000/t-63/ticket.md')).toBeNull();
  });
});
