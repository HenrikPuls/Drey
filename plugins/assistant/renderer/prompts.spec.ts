import {
  PROMPTS_DIR,
  parsePromptFile,
  promptEntriesFrom,
  promptTitleFallback,
} from './prompts';

/**
 * Specs for the prompt picker's pure parsing
 * (`plugins/assistant/renderer/prompts.ts`): the owner's `# Title` /
 * `> Description` / body format and the `templates/prompts/` filter.
 * The Angular runner ignores `plugins/**`, so plugin specs live here.
 */

describe('parsePromptFile', () => {
  it('splits title, description and body', () => {
    expect(
      parsePromptFile(
        `${PROMPTS_DIR}/review.md`,
        '# Review\n> Check the note for contradictions.\nRead the note and list contradictions.\n',
      ),
    ).toEqual({
      path: `${PROMPTS_DIR}/review.md`,
      title: 'Review',
      description: 'Check the note for contradictions.',
      body: 'Read the note and list contradictions.',
    });
  });

  it('treats a missing description as ""', () => {
    const parsed = parsePromptFile(`${PROMPTS_DIR}/plain.md`, '# Titled\n\nJust do it.\n');
    expect(parsed.title).toBe('Titled');
    expect(parsed.description).toBe('');
    expect(parsed.body).toBe('Just do it.');
  });

  it('falls back to the file name when there is no # heading', () => {
    const parsed = parsePromptFile(`${PROMPTS_DIR}/untertitel.md`, 'nur Text');
    expect(parsed.title).toBe('untertitel');
    expect(parsed.description).toBe('');
    expect(parsed.body).toBe('nur Text');
  });

  it('tolerates blank lines between the parts and trims the body', () => {
    const parsed = parsePromptFile(
      `${PROMPTS_DIR}/x.md`,
      '# Titel\n\n\n> Beschreibung\n\n\nKörper\n\n\n',
    );
    expect(parsed.title).toBe('Titel');
    expect(parsed.description).toBe('Beschreibung');
    expect(parsed.body).toBe('Körper');
  });

  it('keeps body lines that start with > after the header block', () => {
    const parsed = parsePromptFile(
      `${PROMPTS_DIR}/deep.md`,
      '# T\n> D\n> not a description\nBody\n',
    );
    expect(parsed.description).toBe('D');
    expect(parsed.body).toBe('> not a description\nBody');
  });

  it('normalises CRLF', () => {
    const parsed = parsePromptFile(`${PROMPTS_DIR}/w.md`, '# T\r\n> D\r\nBody\r\n');
    expect(parsed.title).toBe('T');
    expect(parsed.description).toBe('D');
    expect(parsed.body).toBe('Body');
  });
});

describe('promptTitleFallback', () => {
  it('strips the folder and a single .md extension', () => {
    expect(promptTitleFallback(`${PROMPTS_DIR}/Mein.Prompt.md`)).toBe('Mein.Prompt');
    expect(promptTitleFallback('a.md')).toBe('a');
  });
});

describe('promptEntriesFrom', () => {
  it('reads only templates/prompts/*.md and sorts by title', async () => {
    const files = new Map<string, string>([
      [`${PROMPTS_DIR}/b.md`, '# B-Titel\nBeschreibung B'],
      [`${PROMPTS_DIR}/a.md`, '# A-Titel\nBeschreibung A'],
      ['templates/daily.md', '# {{date}}'],
      [`${PROMPTS_DIR}/nested/c.md`, '# C'],
      [`${PROMPTS_DIR}/notes.txt`, '# ignored'],
    ]);
    const entries = await promptEntriesFrom([...files.keys()], (path) => {
      const text = files.get(path);
      if (text === undefined) {
        return Promise.reject(new Error(`missing ${path}`));
      }
      return Promise.resolve(text);
    });

    expect(entries.map((entry) => entry.title)).toEqual(['A-Titel', 'B-Titel', 'C']);
    expect(entries[0]?.path).toBe(`${PROMPTS_DIR}/a.md`);
  });
});
