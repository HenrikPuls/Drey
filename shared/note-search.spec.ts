import { describe, expect, it } from 'vitest';
import { findLines, queryTerms } from './note-search';

describe('queryTerms', () => {
  it('keeps quoted phrases whole and splits the rest on spaces', () => {
    expect(queryTerms('boat "new sail"  trim')).toEqual(['boat', 'new sail', 'trim']);
  });
});

describe('findLines', () => {
  const note = '# Boat\nnew sail\ntrim the mast\n# Car\nnew tyres\n';

  it('asks all words of one section and reports the matching lines with their heading', () => {
    const hits = findLines(note, { kind: 'words', terms: ['sail', 'mast'], caseSensitive: false });
    expect(hits).toEqual([
      { line: 2, heading: 'Boat' },
      { line: 3, heading: 'Boat' },
    ]);
  });

  it('finds nothing when the words sit in different sections', () => {
    expect(findLines(note, { kind: 'words', terms: ['sail', 'tyres'], caseSensitive: false })).toEqual([]);
  });

  it('matches a regular expression line by line', () => {
    expect(findLines(note, { kind: 'regex', regex: /^new/ }).map((hit) => hit.line)).toEqual([2, 5]);
  });
});
