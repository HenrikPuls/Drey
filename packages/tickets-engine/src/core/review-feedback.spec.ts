import { describe, expect, it } from 'vitest';
import {
  MAX_REVIEW_COMMENTS,
  parseFeedbackBlock,
  parseReviewComments,
  renderFeedbackBlock,
  sendBackNoteOf,
  withReviewFeedback,
  type ReviewComment,
} from './review-feedback';

const A: ReviewComment = { file: 'src/a.ts', line: 27, endLine: null, text: 'Should the guard live in the caller?' };
const B: ReviewComment = { file: 'src/a.ts', line: 30, endLine: 33, text: 'Rename this.' };

const TICKET = `---
id: T-1
---

## Plan

Do it.

## Handover

State: done
Verified: npm test

## Log

- one
`;

describe('parseReviewComments', () => {
  it('keeps well-formed comments and drops the rest', () => {
    const out = parseReviewComments([
      { file: 'a.ts', line: 3, text: '  fix\n this  ' },
      { file: 'a.ts', line: 0, text: 'bad line' },
      { file: '', line: 1, text: 'no file' },
      { file: 'a.ts', line: 1, text: '   ' },
      { file: 'a`b.ts', line: 1, text: 'tick in the path' },
      { file: 'a.ts', line: 4, endLine: 2, text: 'range backwards' },
      { file: 'a.ts', line: 5, endLine: 8, text: 'range' },
      'junk',
      null,
    ]);
    expect(out).toEqual([
      { file: 'a.ts', line: 3, endLine: null, text: 'fix this' },
      { file: 'a.ts', line: 4, endLine: null, text: 'range backwards' },
      { file: 'a.ts', line: 5, endLine: 8, text: 'range' },
    ]);
  });

  it('caps the list and reads a non-list as empty', () => {
    const many = Array.from({ length: MAX_REVIEW_COMMENTS + 9 }, (_, i) => ({ file: 'a.ts', line: i + 1, text: 'x' }));
    expect(parseReviewComments(many)).toHaveLength(MAX_REVIEW_COMMENTS);
    expect(parseReviewComments(undefined)).toEqual([]);
    expect(parseReviewComments({})).toEqual([]);
  });
});

describe('the feedback block', () => {
  it('renders one line per comment and reads back', () => {
    const block = renderFeedbackBlock([A, B]);
    expect(block).toBe(
      '### Review feedback\n\n- `src/a.ts:27` — Should the guard live in the caller?\n- `src/a.ts:30-33` — Rename this.\n',
    );
    expect(parseFeedbackBlock(`\n${block}`)).toEqual([A, B]);
  });
});

describe('withReviewFeedback', () => {
  it('appends the block to an existing Handover and leaves the rest alone', () => {
    const out = withReviewFeedback(TICKET, [A]);
    expect(out).toContain('State: done\nVerified: npm test\n\n### Review feedback\n\n- `src/a.ts:27` — Should the guard live in the caller?\n\n## Log');
    expect(out.startsWith(TICKET.slice(0, TICKET.indexOf('## Log') - 1))).toBe(true);
    expect(out.endsWith('## Log\n\n- one\n')).toBe(true);
    expect(parseFeedbackBlock(out)).toEqual([A]);
  });

  it('replaces an earlier block instead of adding a second one', () => {
    const once = withReviewFeedback(TICKET, [A]);
    const twice = withReviewFeedback(once, [B]);
    expect(twice.match(/### Review feedback/g)).toHaveLength(1);
    expect(parseFeedbackBlock(twice)).toEqual([B]);
    expect(twice).toContain('State: done');
    expect(twice).toContain('## Log');
  });

  it('creates the Handover section before the Log when there is none', () => {
    const bare = TICKET.replace(/## Handover[\s\S]*?(?=## Log)/, '');
    const out = withReviewFeedback(bare, [A]);
    expect(out.indexOf('## Handover')).toBeGreaterThan(out.indexOf('## Plan'));
    expect(out.indexOf('## Handover')).toBeLessThan(out.indexOf('## Log'));
    expect(parseFeedbackBlock(out)).toEqual([A]);
  });

  it('works when the Handover is the last section, and with no comments is a no-op', () => {
    const last = TICKET.replace(/\n## Log[\s\S]*$/, '');
    const out = withReviewFeedback(last, [A]);
    expect(out.trimEnd().endsWith('Should the guard live in the caller?')).toBe(true);
    expect(parseFeedbackBlock(out)).toEqual([A]);
    expect(withReviewFeedback(TICKET, [])).toBe(TICKET);
  });
});

describe('sendBackNoteOf', () => {
  it('keeps the owner’s words, and lets the comment count stand in for missing ones', () => {
    expect(sendBackNoteOf('  rename it ', 3)).toBe('rename it');
    expect(sendBackNoteOf('', 1)).toBe('1 review comment');
    expect(sendBackNoteOf(' ', 2)).toBe('2 review comments');
    expect(sendBackNoteOf('', 0)).toBe('');
  });
});
