import { describe, expect, it } from 'vitest';
import { documentRelPath, documentTitle, idInVaultPath, idOfDocumentPath } from './document-paths';

describe('idInVaultPath: a checkout inside a larger vault (D-25)', () => {
  it('finds the document under any prefix', () => {
    expect(idInVaultPath('tickets/t/0000/t-63/ticket.md')).toBe('T-0063');
    expect(idInVaultPath('work/store/tickets/t/0000/t-63/ticket.md')).toBe('T-0063');
    expect(idInVaultPath('work\\store\\tickets\\t\\0001\\t-1204\\ticket.md')).toBe('T-1204');
  });

  it('does not take a look-alike', () => {
    expect(idInVaultPath('work/tickets/t/0009/t-63/ticket.md')).toBeNull();
    expect(idInVaultPath('work/tickets/t/0000/t-63/comments/ticket.md')).toBeNull();
    expect(idInVaultPath('work/mytickets/t/0000/t-63/ticket.md')).toBeNull();
    expect(idInVaultPath('work/notes/t/0000/t-63/ticket.md')).toBeNull();
  });
});

describe('ticket document paths (E14-4c)', () => {
  it('maps a display id to the sharded checkout path and back', () => {
    expect(documentRelPath('T-0063')).toBe('tickets/t/0000/t-63/ticket.md');
    expect(documentRelPath('T-1500')).toBe('tickets/t/0001/t-1500/ticket.md');
    expect(idOfDocumentPath('tickets/t/0000/t-63/ticket.md')).toBe('T-0063');
    expect(idOfDocumentPath('tickets\\t\\0001\\t-1500\\ticket.md')).toBe('T-1500');
  });

  it('titles a ticket document with its id and title (D-15)', () => {
    const text = '---\nid: t-3\ntitle: Pin tabs to the left\nstage: inbox\nrev: 4\n---\nBody\n';
    expect(documentTitle('tickets/t/0000/t-3/ticket.md', text)).toBe('T-0003 · Pin tabs to the left');
    expect(documentTitle('tickets\\t\\0000\\t-3\\ticket.md', text)).toBe('T-0003 · Pin tabs to the left');
    // No title in the text yet: the id still tells two tabs apart.
    expect(documentTitle('tickets/t/0000/t-3/ticket.md', 'no frontmatter')).toBe('T-0003');
    // Anything else in the tree keeps its own name.
    expect(documentTitle('tickets/t/0000/t-3/comments/a.md', text)).toBeNull();
  });

  it('knows nothing else as a ticket document', () => {
    expect(documentRelPath('not-an-id')).toBeNull();
    expect(idOfDocumentPath('tickets/t/0000/t-63/comments/a.md')).toBeNull();
    expect(idOfDocumentPath('tickets/t/0009/t-63/ticket.md')).toBeNull();
    expect(idOfDocumentPath('notes/t/0000/t-63/ticket.md')).toBeNull();
  });
});
