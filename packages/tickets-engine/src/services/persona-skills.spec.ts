import { describe, expect, it } from 'vitest';
import { loadPersonaSkills } from '../core/persona';

/** D-46: `persona.skills` names files; this is where a name is looked for, nearest first. */
describe('loadPersonaSkills', () => {
  const files: Readonly<Record<string, string>> = {
    'tickets/_meta/personas/p/skills/own.md': 'Own skill.',
    'tickets/_meta/skills/own.md': 'The shared one loses.',
    'tickets/_meta/personas/p/skills/folder/SKILL.md': 'Folder skill.',
    'tickets/_meta/skills/shared.md': 'Shared skill.',
    'tickets/_meta/skills/blank.md': '   ',
  };
  const read = async (rel: string): Promise<string | null> => files[rel] ?? null;

  it('finds them nearest first, in the order the record names them', async () => {
    const found = await loadPersonaSkills(read, 'p', ['shared', 'own', 'folder']);
    expect(found.skills).toEqual([
      { name: 'shared', text: 'Shared skill.' },
      { name: 'own', text: 'Own skill.' },
      { name: 'folder', text: 'Folder skill.' },
    ]);
    expect(found.missing).toEqual([]);
  });

  it('a name with no file, a blank file or a path in it is reported missing and never read', async () => {
    const asked: string[] = [];
    const found = await loadPersonaSkills(
      async (rel) => {
        asked.push(rel);
        return read(rel);
      },
      'p',
      ['nope', 'blank', '../../secret', ''],
    );
    expect(found.skills).toEqual([]);
    expect(found.missing).toEqual(['nope', 'blank', '../../secret', '']);
    expect(asked.some((rel) => rel.includes('secret'))).toBe(false);
  });
});
