import { describe, expect, it } from 'vitest';
import type { BoardSnapshot } from '../shared/tickets';
import { isStoreDocumentPath, storeDocumentHeader, storeDocumentHeaderEdit } from './store-document-header';

const PATH = 'tickets/t/0000/t-30/ticket.md';
const FRONTMATTER = ['---', 'id: t-30', 'title: From the document: with a colon', 'stage: inbox', 'owner: ', 'x-legacy-id: T-0030', '---'].join('\n');

const PREFIXED = 'work/store/tickets/t/0000/t-30/ticket.md';

const snapshot = {
  columns: [
    {
      tickets: [
        {
          id: 'T-0030',
          path: 'tickets/build/T-0030.md',
          phase: 'build',
          meta: { id: 'T-0030', title: 'From the board', priority: 'normal' },
          issues: [{ level: 'warning', message: 'a card issue' }],
        },
      ],
    },
  ],
} as unknown as BoardSnapshot;

describe('isStoreDocumentPath', () => {
  it('takes the store shape only', () => {
    expect(isStoreDocumentPath(PATH)).toBe(true);
    expect(isStoreDocumentPath('tickets/50-build/T-0030.md')).toBe(false);
    expect(isStoreDocumentPath('notes/a.md')).toBe(false);
  });
});

describe('storeDocumentHeader', () => {
  it("answers with the board's card, not the files parser's unexpected-path error", () => {
    const reply = storeDocumentHeader(PATH, FRONTMATTER, snapshot);
    expect(reply).toMatchObject({ ok: true, meta: { id: 'T-0030', priority: 'normal' }, issues: [{ message: 'a card issue' }] });
  });

  it("takes the title from the buffer, the flat format's colon included", () => {
    const reply = storeDocumentHeader(PATH, FRONTMATTER, snapshot);
    expect(reply.ok && reply.meta.title).toBe('From the document: with a colon');
  });

  it("falls back to the card's title when the buffer has none", () => {
    const reply = storeDocumentHeader(PATH, '---\nid: t-30\ntitle: \n---', snapshot);
    expect(reply.ok && reply.meta.title).toBe('From the board');
  });

  it('says so when the board does not list the ticket', () => {
    expect(storeDocumentHeader('tickets/t/0000/t-31/ticket.md', FRONTMATTER, snapshot).ok).toBe(false);
  });
});

describe('storeDocumentHeaderEdit', () => {
  it('rewrites only the title line, as flat text and not YAML', () => {
    const reply = storeDocumentHeaderEdit(PATH, FRONTMATTER, { title: 'New: still no quotes' }, snapshot);
    if (!reply.ok) {
      throw new Error(reply.error);
    }
    expect(reply.frontmatter).toBe(FRONTMATTER.replace('title: From the document: with a colon', 'title: New: still no quotes'));
    expect(reply.meta.title).toBe('New: still no quotes');
  });

  it('refuses what the header does not edit on a store', () => {
    expect(storeDocumentHeaderEdit(PATH, FRONTMATTER, { priority: 'high' }, snapshot).ok).toBe(false);
    expect(storeDocumentHeaderEdit(PATH, FRONTMATTER, { title: 'x', priority: 'high' }, snapshot).ok).toBe(false);
  });

  it('answers an error for a title that would break the line', () => {
    expect(storeDocumentHeaderEdit(PATH, FRONTMATTER, { title: 'a\nstage: done' }, snapshot).ok).toBe(false);
  });
});

describe('a checkout inside a larger vault (D-25)', () => {
  it('answers the header model of a prefixed document', () => {
    expect(isStoreDocumentPath(PREFIXED)).toBe(true);
    const reply = storeDocumentHeader(PREFIXED, FRONTMATTER, snapshot);
    expect(reply.ok && reply.meta.id).toBe('T-0030');
  });

  it('edits the title of a prefixed document', () => {
    const reply = storeDocumentHeaderEdit(PREFIXED, FRONTMATTER, { title: 'Renamed' }, snapshot);
    expect(reply.ok && reply.frontmatter).toContain('title: Renamed');
  });
});
