import { TaskIndex } from '../../../plugins/tasks/main/task-index';

/**
 * The Tasks plugin's per-vault index (`plugins/tasks/main/task-index`),
 * formerly `electron/tasks/TaskIndex` (ADR-0044 stage 6, one index per
 * registered vault since milestone 34 — the last piece of the M-B
 * follow-up). Like the Tags plugin's index it always excludes the literal
 * `templates/` folder and the user-configured templates folder, includes
 * `daily/`, and re-indexes one file on save. The spec lives under
 * `src/app/services/` because the ng test runner ignores `plugins/**`.
 */

const FILES: Record<string, Record<string, string>> = {
  home: {
    'daily/2026/09/2026-09-08.md': '## 08:00\n- [ ] ship report\n- [x] coffee\n',
    'templates/meeting.md': '- [ ] never a task, this is a template\n',
    'meta/templates/note.md': '- [ ] template task\n',
    'notes/real.md': 'Follow up with the landlord #task\n',
  },
  work: {
    'sprint.md': '- [ ] land the release\n',
  },
};

function makeIndex(): TaskIndex {
  const index = new TaskIndex(
    async (vaultId) => Object.keys(FILES[vaultId] ?? {}),
    () => 'meta/templates',
  );
  index.setReadContent(async (vaultId, p) => FILES[vaultId]?.[p] ?? '');
  return index;
}

describe('TaskIndex', () => {
  it('collects tasks from real notes and daily notes, skipping template folders', async () => {
    const index = makeIndex();
    await index.requestRebuild('home');
    const texts = index.all().map((t) => `${t.text}:${t.done}`);
    expect(texts).toEqual(
      expect.arrayContaining([
        'ship report:false',
        'coffee:true',
        'Follow up with the landlord:false',
      ]),
    );
    expect(texts.some((t) => t.includes('template'))).toBe(false);
  });

  it('stamps every record with its owning vault', async () => {
    const index = makeIndex();
    await index.requestRebuildAll(['home', 'work']);
    expect(index.all().filter((t) => t.text === 'land the release')).toEqual([
      {
        path: 'sprint.md',
        vaultId: 'work',
        line: 1,
        text: 'land the release',
        done: false,
        kind: 'checkbox',
        heading: null,
        tags: [],
      },
    ]);
    expect(index.all().every((t) => t.vaultId === 'home' || t.vaultId === 'work')).toBe(true);
  });

  it('keeps two vaults isolated — one vault’s sweep never sees the other’s files', async () => {
    const index = makeIndex();
    await index.requestRebuild('home');
    expect(index.all().some((t) => t.path === 'sprint.md')).toBe(false);

    await index.requestRebuild('work');
    expect(index.all().some((t) => t.text === 'Follow up with the landlord')).toBe(true);
    expect(index.all().some((t) => t.text === 'land the release')).toBe(true);
  });

  it('re-indexes one file per vault and drops it when it moves under a template folder', async () => {
    const index = makeIndex();
    await index.requestRebuild('home');

    index.reindexFile('home', 'notes/real.md', '- [ ] new one\n- [x] done one\n');
    expect(
      index
        .all()
        .filter((t) => t.path === 'notes/real.md')
        .map((t) => t.text),
    ).toEqual(['new one', 'done one']);

    index.reindexFile('home', 'meta/templates/real.md', '- [ ] should be excluded\n');
    expect(index.all().some((t) => t.path === 'meta/templates/real.md')).toBe(false);
  });

  it('a save into another vault touches only that vault’s map', async () => {
    const index = makeIndex();
    await index.requestRebuildAll(['home', 'work']);

    index.reindexFile('work', 'sprint.md', '- [x] landed\n');
    expect(
      index
        .all()
        .filter((t) => t.path === 'sprint.md')
        .map((t) => t.done),
    ).toEqual([true]);
    // The home vault's records are untouched by the work-vault save.
    expect(index.all().filter((t) => t.vaultId === 'home')).toHaveLength(3);
  });

  it('forgets a deleted file, scoped to its vault', async () => {
    const index = makeIndex();
    await index.requestRebuild('home');
    expect(index.all().some((t) => t.path === 'notes/real.md')).toBe(true);
    index.removeFile('home', 'notes/real.md');
    expect(index.all().some((t) => t.path === 'notes/real.md')).toBe(false);
  });

  it('drops a vault’s index when the vault is unregistered', async () => {
    const index = makeIndex();
    await index.requestRebuildAll(['home', 'work']);
    index.dropVault('work');
    expect(index.all().every((t) => t.vaultId === 'home')).toBe(true);
    expect(index.knownVaults()).toEqual(['home']);
  });
});
