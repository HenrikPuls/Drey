import { createTaskQueryProvider, type TaskProviderPorts } from './task-provider';
import { scanTasks } from '../shared/tasks';
import type { SdkTaskRecord } from '../../../shared/plugin-api';

/**
 * Specs for the tasks plugin's `TaskQueryProvider` (SDK 1.11): the seam
 * the assistant's `tasks_list` tool and MCP `tasks_list` read — query
 * scoping lives here, and the done toggle goes through the plugin's own
 * line grammar (`resolveTaskLine` staleness handling included).
 */

function harness(content: string): {
  provider: ReturnType<typeof createTaskQueryProvider>;
  writes: Array<{ path: string; vaultId: string; content: string }>;
  readonly announced: number;
  reindexed: string[];
} {
  const writes: Array<{ path: string; vaultId: string; content: string }> = [];
  const reindexed: string[] = [];
  let announcedCount = 0;
  const ports: TaskProviderPorts = {
    read: async () => content,
    writeAnnounced: async (path, next, vaultId) => {
      writes.push({ path, vaultId, content: next });
    },
    all: () => scanTasks('daily/a.md', content, 'v1'),
    reindex: (vaultId, path) => {
      reindexed.push(`${vaultId}::${path}`);
    },
    announce: () => {
      announcedCount += 1;
    },
  };
  return {
    provider: createTaskQueryProvider(ports),
    writes,
    get announced(): number {
      return announcedCount;
    },
    reindexed,
  };
}

const NOTE = [
  '# Tag',
  '',
  '- [ ] Offene Aufgabe 📅 2026-10-02',
  '- [x] Erledigte Aufgabe',
  '- [ ] Checkbox mit #task Marker',
  '#task Tag-Task',
  '',
].join('\n');

describe('tasks plugin — TaskQueryProvider (SDK 1.11)', () => {
  it('queries open tasks by default, done only on request, scoped per vault', async () => {
    const { provider } = harness(NOTE);
    const open = await provider.query();
    expect(open.map((t) => t.text)).toEqual(['Offene Aufgabe', 'Checkbox mit Marker', 'Tag-Task']);

    const all = await provider.query({ includeDone: true });
    expect(all).toHaveLength(4);

    const otherVault = await provider.query({ vaultId: 'v2' });
    expect(otherVault).toEqual([]);
  });

  it('records carry the contract shape (due, priority, vault, line)', async () => {
    const { provider } = harness(NOTE);
    const open = await provider.query();
    expect(open[0]).toMatchObject({
      path: 'daily/a.md',
      vaultId: 'v1',
      line: 3,
      text: 'Offene Aufgabe',
      done: false,
      kind: 'checkbox',
      due: '2026-10-02',
      priority: null,
    } satisfies Partial<SdkTaskRecord>);
  });

  it('setDone flips the checkbox line, writes announced, re-indexes and announces', async () => {
    const h = harness(NOTE);
    const task = (await h.provider.query())[0];

    const updated = await h.provider.setDone(task, true);

    expect(updated.done).toBe(true);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({ path: 'daily/a.md', vaultId: 'v1' });
    expect(h.writes[0].content).toContain('- [x] Offene Aufgabe 📅 2026-10-02');
    expect(h.reindexed).toEqual(['v1::daily/a.md']);
    expect(h.announced).toBe(1);
  });

  it('setDone re-resolves a shifted line through the same text', async () => {
    // The fence recorded line 3, but a frontmatter bump shifted the body
    // down — the toggle must land on the text, not the number.
    const content = `---\ncreated: "2026-10-10"\n---\n\n${NOTE}`;
    const h = harness(content);
    const task = { ...(await harness(NOTE).provider.query())[0] };

    const updated = await h.provider.setDone(task, true);

    expect(updated.done).toBe(true);
    expect(h.writes[0].content).toContain('[x] Offene Aufgabe');
  });

  it('setDone throws when the task is gone (never a silent no-op)', async () => {
    const h = harness('- [ ] Etwas anderes\n');
    const task = (await harness(NOTE).provider.query())[0];
    await expect(h.provider.setDone(task, true)).rejects.toThrow(/could not be located/);
  });

  it('a tag-kind task toggles through #task/done, not a checkbox', async () => {
    const h = harness(NOTE);
    const tagTask = (await h.provider.query()).find((t) => t.kind === 'tag');
    expect(tagTask).toBeDefined();

    const updated = await h.provider.setDone(tagTask!, true);
    expect(updated.done).toBe(true);
    expect(h.writes[0].content).toContain('#task/done');
  });
});

describe('tasks plugin — deterministic views through the provider (SDK 1.12)', () => {
  /**
   * One file per due/priority combination, in file order. Due dates are
   * RELATIVE to the real today (the `overdue` filter anchors there):
   * yesterday-9 is overdue, tomorrow is not.
   */
  function viewNote(): string {
    const day = (offset: number): string => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      const pad = (v: number): string => String(v).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    return [
      '# View',
      '',
      '- [ ] Undatiert normal',
      '- [ ] Undatiert hoch ⏫',
      `- [ ] Überfällig 🔺 📅 ${day(-9)}`,
      `- [ ] Bald 📅 ${day(1)}`,
      `- [ ] Später 🔽 📅 ${day(30)}`,
      '- [x] Erledigt mit Tag #thema',
      '',
    ].join('\n');
  }

  it('importance sorts due ascending first, priority second, location last', async () => {
    const { provider } = harness(viewNote());
    const ordered = (await provider.query({ sort: 'importance' })).map((t) => t.text);
    expect(ordered).toEqual([
      'Überfällig', // oldest due, highest — urgency first
      'Bald', // tomorrow
      'Später', // in 30 days
      'Undatiert hoch', // undated: priority decides
      'Undatiert normal',
    ]);
  });

  it('due/priority/file keep the panel semantics', async () => {
    const { provider } = harness(viewNote());
    expect((await provider.query({ sort: 'due' })).map((t) => t.text)).toEqual([
      'Überfällig',
      'Bald',
      'Später',
      'Undatiert normal', // undated last, ties by location
      'Undatiert hoch',
    ]);
    expect((await provider.query({ sort: 'priority' })).map((t) => t.text)).toEqual([
      'Überfällig',
      'Undatiert hoch',
      'Undatiert normal',
      'Bald',
      'Später',
    ]);
    // Default (no sort): the file order the panel's file mode shows.
    expect((await provider.query()).map((t) => t.text)[0]).toBe('Undatiert normal');
  });

  it('overdue filters to due-before-today only', async () => {
    const { provider } = harness(viewNote());
    const overdue = await provider.query({ overdue: true });
    expect(overdue.map((t) => t.text)).toEqual(['Überfällig']);
  });

  it('text filters terms AND across text + heading', async () => {
    const { provider } = harness(viewNote());
    expect((await provider.query({ text: 'undatiert NORMAL' })).map((t) => t.text)).toEqual([
      'Undatiert normal',
    ]);
    expect(await provider.query({ text: 'keinsfindet' })).toEqual([]);
  });

  it('tag filters over the SECTION tags — every task in the section carries them', async () => {
    const { provider } = harness(viewNote());
    // `#thema` sits on one line but tags are section-scoped: all tasks of
    // the `# View` section match (the done one only on request).
    expect((await provider.query({ tag: 'thema' }))).toHaveLength(5);
    expect((await provider.query({ tag: 'thema', includeDone: true }))).toHaveLength(6);
    expect(await provider.query({ tag: 'anderes' })).toEqual([]);
  });

  it('filters compose (overdue + text matches only the overdue one)', async () => {
    const { provider } = harness(viewNote());
    const composed = await provider.query({ overdue: true, text: 'überfällig' });
    expect(composed.map((t) => t.text)).toEqual(['Überfällig']);
  });
});

describe('tasks plugin — TaskQueryProvider status + completion views (SDK 1.13)', () => {
  const DONE_NOTE = [
    '- [ ] Noch offen',
    '- [x] Letzte Woche ✅ 2026-10-03',
    '- [x] Gestern ✅ 2026-10-09',
    '- [x] Ohne Datum',
    '',
  ].join('\n');

  it('status selects open, done or all; it wins over includeDone', async () => {
    const { provider } = harness(DONE_NOTE);
    expect((await provider.query({ status: 'open' })).map((t) => t.text)).toEqual(['Noch offen']);
    expect(await provider.query({ status: 'done' })).toHaveLength(3);
    expect(await provider.query({ status: 'all' })).toHaveLength(4);
    expect(await provider.query({ status: 'done', includeDone: false })).toHaveLength(3);
    expect(await provider.query({ status: 'open', includeDone: true })).toHaveLength(1);
  });

  it('the completed sort lists the newest completion first, undated last', async () => {
    const { provider } = harness(DONE_NOTE);
    const done = await provider.query({ status: 'done', sort: 'completed' });
    expect(done.map((t) => t.text)).toEqual(['Gestern', 'Letzte Woche', 'Ohne Datum']);
    expect(done[0].completed).toBe('2026-10-09');
  });

  it('completedSince keeps tasks completed on or after the date; undated ones drop', async () => {
    const { provider } = harness(DONE_NOTE);
    const recent = await provider.query({ status: 'done', completedSince: '2026-10-09' });
    expect(recent.map((t) => t.text)).toEqual(['Gestern']);
  });

  it('setDone stamps the completion date and reopening removes it', async () => {
    const h = harness('- [ ] Abhaken\n');
    const task = (await h.provider.query())[0];
    const updated = await h.provider.setDone(task, true);
    expect(h.writes[0].content).toMatch(/^- \[x\] Abhaken ✅ \d{4}-\d{2}-\d{2}\n$/);
    expect(updated.completed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(updated.text).toBe('Abhaken');

    const reopen = harness('- [x] Abhaken ✅ 2026-10-09\n');
    const doneTask = (await reopen.provider.query({ status: 'done' }))[0];
    await reopen.provider.setDone(doneTask, false);
    expect(reopen.writes[0].content).toBe('- [ ] Abhaken\n');
  });
});
