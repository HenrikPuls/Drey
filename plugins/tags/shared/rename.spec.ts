import { describe, expect, it } from 'vitest';
import { normalizeTagName, renameTagInContent } from './rename.js';

describe('normalizeTagName', () => {
  it('accepts plain and nested names, strips # and case', () => {
    expect(normalizeTagName('#Projekt')).toBe('projekt');
    expect(normalizeTagName('  Projekt/Frontend ')).toBe('projekt/frontend');
  });

  it('rejects empty, broken and trailing-slash names', () => {
    expect(normalizeTagName('')).toBeNull();
    expect(normalizeTagName('#')).toBeNull();
    expect(normalizeTagName('#proj!kt')).toBeNull();
    expect(normalizeTagName('#proj/')).toBeNull();
    expect(normalizeTagName('#2026')).toBeNull();
  });

  it('rejects the reserved task root', () => {
    expect(normalizeTagName('#task')).toBeNull();
    expect(normalizeTagName('#task/heute')).toBeNull();
  });
});

describe('renameTagInContent', () => {
  it('renames every exact occurrence and leaves other tags alone', () => {
    const content = '# Heading\nA #old note and another #old line.\nAlso #oldnet, #old-x and #other stay.';
    const patch = renameTagInContent(content, 'old', 'new', false);
    expect(patch?.after).toBe(
      '# Heading\nA #new note and another #new line.\nAlso #oldnet, #old-x and #other stay.',
    );
    expect(patch?.occurrences).toBe(2);
  });

  it('is case-insensitive on the source and writes the normalized target', () => {
    const patch = renameTagInContent('Heute #Old gelesen.', 'old', 'new', false);
    expect(patch?.after).toBe('Heute #new gelesen.');
  });

  it('renames descendants with the tail spelling preserved', () => {
    const patch = renameTagInContent('x #old/Frontend y #old/sub/deep z #old', 'old', 'new', true);
    expect(patch?.after).toBe('x #new/Frontend y #new/sub/deep z #new');
    expect(patch?.occurrences).toBe(3);
  });

  it('leaves descendants alone when they are excluded', () => {
    const patch = renameTagInContent('x #old/sub y #old', 'old', 'new', false);
    expect(patch?.after).toBe('x #old/sub y #new');
    expect(patch?.occurrences).toBe(1);
  });

  it('never touches fenced or inline code', () => {
    const content = '```\n#old in a fence\n```\nInline `#old` code. Real #old.';
    const patch = renameTagInContent(content, 'old', 'new', false);
    expect(patch?.after).toBe('```\n#old in a fence\n```\nInline `#old` code. Real #new.');
  });

  it('never touches url fragments or hash runs', () => {
    const content = 'See https://x.test/#old and ## 14:32.';
    expect(renameTagInContent(content, 'old', 'new', false)).toBeNull();
  });

  it('drops the duplicate a merge creates next to an existing target', () => {
    const patch = renameTagInContent('ref #old #new note', 'old', 'new', false);
    expect(patch?.after).toBe('ref #new note');
    expect(patch?.occurrences).toBe(1);
  });

  it('drops the duplicate in either order, but keeps pre-existing duplicates', () => {
    expect(renameTagInContent('a #new #old', 'old', 'new', false)?.after).toBe('a #new');
    expect(renameTagInContent('a #new #new #old', 'old', 'new', false)?.after).toBe('a #new #new');
    expect(renameTagInContent('a #new #new', 'old', 'new', false)).toBeNull();
  });

  it('dedupes mapped descendants too', () => {
    expect(renameTagInContent('x #old/sub #new/sub', 'old', 'new', true)?.after).toBe('x #new/sub');
  });

  it('returns null for no match, same names, or empty input', () => {
    expect(renameTagInContent('nothing here', 'old', 'new', true)).toBeNull();
    expect(renameTagInContent('#old', 'old', 'old', false)).toBeNull();
    expect(renameTagInContent('#old', '', 'new', false)).toBeNull();
  });
});
