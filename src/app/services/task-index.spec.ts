import { TaskIndex } from '../../../plugins/tasks/main/task-index';

/**
 * The Tasks plugin's whole-vault index (`plugins/tasks/main/task-index`),
 * formerly `electron/tasks/TaskIndex` (ADR-0044 stage 6). Like the Tags
 * plugin's index it always excludes the literal `templates/` folder and
 * the user-configured templates folder, includes `daily/`, and re-indexes
 * one file on save. The spec lives under `src/app/services/` because the
 * ng test runner ignores `plugins/**`.
 */

const FILES: Record<string, string> = {
  'daily/2026/09/2026-09-08.md': '## 08:00\n- [ ] ship report\n- [x] coffee\n',
  'templates/meeting.md': '- [ ] never a task, this is a template\n',
  'meta/templates/note.md': '- [ ] template task\n',
  'notes/real.md': 'Follow up with the landlord #task\n',
};

function makeIndex(): TaskIndex {
  const index = new TaskIndex(async () => Object.keys(FILES), () => 'meta/templates');
  index.setReadContent(async (p) => FILES[p] ?? '');
  return index;
}

describe('TaskIndex', () => {
  it('collects tasks from real notes and daily notes, skipping template folders', async () => {
    const index = makeIndex();
    await index.rebuild();
    const texts = index.all().map((t) => `${t.text}:${t.done}`);
    expect(texts).toEqual(
      expect.arrayContaining(['ship report:false', 'coffee:true', 'Follow up with the landlord:false']),
    );
    expect(texts.some((t) => t.includes('template'))).toBe(false);
  });

  it('re-indexes one file on save and drops it when it moves under a template folder', async () => {
    const index = makeIndex();
    await index.rebuild();

    index.reindexFile('notes/real.md', '- [ ] new one\n- [x] done one\n');
    expect(index.all().filter((t) => t.path === 'notes/real.md').map((t) => t.text)).toEqual([
      'new one',
      'done one',
    ]);

    index.reindexFile('meta/templates/real.md', '- [ ] should be excluded\n');
    expect(index.all().some((t) => t.path === 'meta/templates/real.md')).toBe(false);
  });

  it('forgets a deleted file', async () => {
    const index = makeIndex();
    await index.rebuild();
    expect(index.all().some((t) => t.path === 'notes/real.md')).toBe(true);
    index.removeFile('notes/real.md');
    expect(index.all().some((t) => t.path === 'notes/real.md')).toBe(false);
  });
});
