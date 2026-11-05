import { describe, expect, it } from 'vitest';
import { detailFromContent } from './dricket-ticket-store';
import { ARCHIVED_LABEL, legacyToDricketDocument } from './legacy-bridge';
import { recordToBoardFile } from './store-board';

const DOC = `---
id: t-7
created_at: 2026-11-05T06:15:07Z
created_by: henrik
schema_version: 1
title: Wire the thing: with a colon
stage: build
owner:
kind: human
size: M
claimed_at:
lease_until:
epoch: 0
rev: 3
extensions: 0
priority: high
labels: placeholder
depends: t-3, t-4
parent: t-1
touches:
branch:
repos: drey, other
x-rank: 4000
x-persona: paul
x-chain: review;commit
x-created-at: 2026-10-17T10:00:00Z
x-entered-build: 2026-11-01T08:00:00Z
---

## Description

Body text.

## Log
- 2026-11-05T06:15:07Z henrik add t-7
`;

function legacyOf(doc: string, phase = 'build'): string {
  return recordToBoardFile(detailFromContent(doc), phase).text;
}

describe('legacyToDricketDocument', () => {
  it('is the inverse of the board fold: an untouched ticket comes back equal', () => {
    const back = legacyToDricketDocument(DOC, legacyOf(DOC), { stage: 'build' });
    const a = detailFromContent(back);
    const b = detailFromContent(DOC);
    expect(a.body).toBe(b.body);
    expect(a.title).toBe(b.title);
    expect(a.dependsOn).toEqual(b.dependsOn);
    expect(a.parent).toBe(b.parent);
    expect(a.repos).toEqual(b.repos);
    expect(a.extensions).toEqual(b.extensions);
    expect(a.rev).toBe(3);
    expect(a.stage).toBe('build');
  });

  it('keeps identity, claim and unmanaged extension fields as dk has them', () => {
    const back = legacyToDricketDocument(DOC, legacyOf(DOC), { stage: 'build' });
    expect(back).toContain('created_at: 2026-11-05T06:15:07Z');
    expect(back).toContain('x-created-at: 2026-10-17T10:00:00Z');
    expect(back).toContain('epoch: 0');
  });

  it('carries a header edit, a new body and a stage change', () => {
    const legacy = legacyOf(DOC)
      .replace('priority: high', 'priority: urgent')
      .replace(/Body text\./, 'Changed body.')
      .replace('persona: paul', 'persona: ben');
    const back = detailFromContent(legacyToDricketDocument(DOC, legacy, { stage: 'commit' }));
    expect(back.priority).toBe('urgent');
    expect(back.stage).toBe('commit');
    expect(back.body).toContain('Changed body.');
    expect(back.extensions['x-persona']).toBe('ben');
  });

  it('drops a managed extension the legacy header no longer has, keeps others', () => {
    const legacy = legacyOf(DOC).replace(/^persona: paul\n/m, '').replace(/^chain:\n.*\n.*\n/m, '');
    const back = detailFromContent(legacyToDricketDocument(DOC, legacy, { stage: 'build' }));
    expect(back.extensions['x-persona']).toBeUndefined();
    expect(back.extensions['x-chain']).toBeUndefined();
    expect(back.extensions['x-created-at']).toBeDefined();
  });

  it('writes blocked-by and parent back as dricket ids', () => {
    const legacy = legacyOf(DOC).replace(/blocked-by:[\s\S]*?\n(?=\S)/, 'blocked-by:\n  - T-0009\n');
    const back = detailFromContent(legacyToDricketDocument(DOC, legacy, { stage: 'build' }));
    expect(back.dependsOn).toEqual(['T-0009']);
    expect(back.parent).toBe('T-0001');
  });

  it('adds and removes the archived label', () => {
    const archived = legacyToDricketDocument(DOC, legacyOf(DOC), { stage: 'done', archived: true });
    expect(detailFromContent(archived).labels).toEqual(['placeholder', ARCHIVED_LABEL]);
    const revived = legacyToDricketDocument(archived, legacyOf(archived, 'done'), { stage: 'build', archived: false });
    expect(detailFromContent(revived).labels).toEqual(['placeholder']);
  });

  it('keeps an x-phase pin in step with the stage', () => {
    const pinned = DOC.replace('x-rank: 4000', 'x-rank: 4000\nx-phase: build');
    const back = detailFromContent(legacyToDricketDocument(pinned, legacyOf(pinned), { stage: 'commit' }));
    expect(back.extensions['x-phase']).toBe('commit');
  });

  it('refuses text that is not a ticket document', () => {
    expect(() => legacyToDricketDocument(DOC, 'no front matter', { stage: 'build' })).toThrow(/fence/);
  });
});
