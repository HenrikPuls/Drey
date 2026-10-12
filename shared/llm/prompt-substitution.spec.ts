import { describe, expect, it } from 'vitest';
import { substituteVocabulary } from './prompt-substitution';

describe('substituteVocabulary (the one {{AVAILABLE_TAGS}} placeholder)', () => {
  it('replaces the token with the tag list, one per line', () => {
    const out = substituteVocabulary('Tags:\n{{AVAILABLE_TAGS}}\nend', ['sailing', 'project/boat']);
    expect(out).toBe('Tags:\nsailing\nproject/boat\nend');
  });

  it('still substitutes the legacy {tags} spelling (stored edited autotag prompts)', () => {
    expect(substituteVocabulary('Existing tags:\n{tags}', ['beta'])).toBe(
      'Existing tags:\nbeta',
    );
  });

  it('never offers the reserved #task', () => {
    const out = substituteVocabulary('{{AVAILABLE_TAGS}}', ['task', 'sailing']);
    expect(out).toBe('sailing');
  });

  it("substitutes '(none yet)' for an empty vocabulary", () => {
    expect(substituteVocabulary('{{AVAILABLE_TAGS}}', [])).toBe('(none yet)');
  });

  it('leaves a prompt without the token untouched', () => {
    expect(substituteVocabulary('no vocabulary here', ['x'])).toBe('no vocabulary here');
  });
});
