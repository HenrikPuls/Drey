import { TagIndex } from '../../../electron/tags';
import type { VaultManager } from '../../../electron/vault-manager';

/**
 * `TagIndex` excludes the literal `templates/` folder always, and the
 * user-configured templates folder on top of that (so snippet headings do
 * not leak into tag search).
 */

const FILES: Record<string, string> = {
  'daily/2026/09/2026-09-08.md': '## 08:00 #work\nnote\n',
  'templates/meeting.md': '## Agenda #meeting\nx\n',
  'meta/templates/note.md': '## Draft #snippet\ny\n',
  'notes/real.md': '## Real #keeper\nz\n',
};

function fakeVault(): VaultManager {
  return {
    listMarkdownFiles: async () => Object.keys(FILES),
    readFile: async (p: string) => ({ content: FILES[p] ?? '', modifiedMs: 0 }),
  } as unknown as VaultManager;
}

describe('TagIndex templates exclusion', () => {
  it('excludes both the literal templates/ folder and the configured one', async () => {
    const index = new TagIndex(fakeVault(), () => 'meta/templates');
    await index.rebuild();
    const tags = index.getVocabulary().map((e) => e.tag);
    expect(tags).toContain('work');
    expect(tags).toContain('keeper');
    expect(tags).not.toContain('meeting'); // literal templates/
    expect(tags).not.toContain('snippet'); // configured meta/templates
  });

  it('falls back to only the literal templates/ folder with no getter', async () => {
    const index = new TagIndex(fakeVault());
    await index.rebuild();
    const tags = index.getVocabulary().map((e) => e.tag);
    expect(tags).not.toContain('meeting');
    expect(tags).toContain('snippet'); // meta/templates is now indexed
  });

  it('drops a file from the index when a save moves it under the configured folder', async () => {
    const index = new TagIndex(fakeVault(), () => 'meta/templates');
    await index.rebuild();
    expect(index.getVocabulary().map((e) => e.tag)).toContain('keeper');

    index.reindexFile('meta/templates/moved.md', '## Moved #gone\n');
    expect(index.getVocabulary().map((e) => e.tag)).not.toContain('gone');
  });
});
