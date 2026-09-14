import { TagIndex } from '../../../plugins/tags/main/tag-index';

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

function listMarkdownFiles(): Promise<string[]> {
  return Promise.resolve(Object.keys(FILES));
}

/** The plugin's index reads file contents through the injected reader. */
const readContent = (p: string): Promise<string> => Promise.resolve(FILES[p] ?? '');

describe('TagIndex templates exclusion', () => {
  it('excludes both the literal templates/ folder and the configured one', async () => {
    const index = new TagIndex(listMarkdownFiles, () => 'meta/templates');
    index.setReadContent(readContent);
    await index.rebuild();
    const tags = index.getVocabulary().map((e) => e.tag);
    expect(tags).toContain('work');
    expect(tags).toContain('keeper');
    expect(tags).not.toContain('meeting'); // literal templates/
    expect(tags).not.toContain('snippet'); // configured meta/templates
  });

  it('falls back to only the literal templates/ folder with no getter', async () => {
    const index = new TagIndex(listMarkdownFiles);
    index.setReadContent(readContent);
    await index.rebuild();
    const tags = index.getVocabulary().map((e) => e.tag);
    expect(tags).not.toContain('meeting');
    expect(tags).toContain('snippet'); // meta/templates is now indexed
  });

  it('drops a file from the index when a save moves it under the configured folder', async () => {
    const index = new TagIndex(listMarkdownFiles, () => 'meta/templates');
    index.setReadContent(readContent);
    await index.rebuild();
    expect(index.getVocabulary().map((e) => e.tag)).toContain('keeper');

    index.reindexFile('meta/templates/moved.md', '## Moved #gone\n');
    expect(index.getVocabulary().map((e) => e.tag)).not.toContain('gone');
  });
});

describe('TagIndex requestRebuild coalescing', () => {
  it('collapses concurrent requests into at most one extra sweep', async () => {
    let sweeps = 0;
    // Assigned by the first sweep's promise executor, before `release()` runs.
    let release!: () => void;
    const index = new TagIndex(() => {
      sweeps += 1;
      if (sweeps === 1) {
        // Hold the first sweep open so the later requests land while one
        // is genuinely in flight.
        return new Promise<string[]>((resolve) => {
          release = () => resolve(Object.keys(FILES));
        });
      }
      return Promise.resolve(Object.keys(FILES));
    });
    index.setReadContent((p) => Promise.resolve(FILES[p] ?? ''));

    const first = index.requestRebuild();

    await Promise.resolve(); // let the first sweep start (its list call pends)
    expect(sweeps).toBe(1);

    // These land WHILE the first sweep is in flight: they must share one
    // extra sweep, not start one each.
    const second = index.requestRebuild();
    const third = index.requestRebuild();
    release();
    await Promise.all([first, second, third]);
    expect(sweeps).toBe(2); // one extra sweep, not one per request

    // A request after the queue drains starts a fresh sweep.
    await index.requestRebuild();
    expect(sweeps).toBe(3);
  });

  it('a save landing during a sweep survives the snapshot swap', async () => {
    let content = '## A #one\n';
    let readGated = false;
    let releaseRead: (() => void) | undefined;
    const index = new TagIndex(() => Promise.resolve(['notes/a.md']));
    index.setReadContent(() => {
      if (!readGated) {
        return Promise.resolve(content);
      }
      return new Promise<string>((resolve) => {
        releaseRead = () => resolve(content); // a stale read: disk as of BEFORE the save
      });
    });

    await index.requestRebuild(); // first sweep: the index knows #one
    expect(index.getVocabulary().map((e) => e.tag)).toEqual(['one']);

    // Second sweep: hold its file read open, land a save mid-sweep.
    readGated = true;
    const sweeping = index.requestRebuild();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(releaseRead).toBeDefined();
    index.reindexFile('notes/a.md', '## A #two\n');
    releaseRead?.();
    await sweeping;

    // The save must survive the swap -- the sweep's stale read must not
    // clobber it (the torn `byPath.clear()` build used to lose it).
    expect(index.getVocabulary().map((e) => e.tag)).toEqual(['two']);
  });

  it('reflects changed content in a later coalesced sweep', async () => {
    let files: Record<string, string> = { 'notes/a.md': '## A #one\n' };
    const index = new TagIndex(() => Promise.resolve(Object.keys(files)));
    index.setReadContent((p) => Promise.resolve(files[p] ?? ''));
    await index.requestRebuild();
    expect(index.getVocabulary().map((e) => e.tag)).toEqual(['one']);

    files = { 'notes/a.md': '## A #two\n', 'notes/b.md': '## B #three\n' };
    await index.requestRebuild();
    expect(index.getVocabulary().map((e) => e.tag).sort()).toEqual(['three', 'two']);
  });
});
