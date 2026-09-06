import { TestBed } from '@angular/core/testing';
import { DreyApi } from '../../../shared/ipc-api';
import { EditorService } from './editor.service';
import { EntryDraftService } from './entry-draft.service';

describe('EntryDraftService', () => {
  let drawer: EntryDraftService;
  let editor: EditorService;

  beforeEach(async () => {
    window.dreyApi = {
      readVaultFile: () => Promise.resolve({ content: '# Note\n', modifiedMs: 1 }),
      listTags: () => Promise.resolve([]),
    } as unknown as DreyApi;

    editor = TestBed.inject(EditorService);
    drawer = TestBed.inject(EntryDraftService);
    await editor.openFile('daily/2026-09-26.md');
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
    localStorage.removeItem('drey.editor');
  });

  it('collects chips, ignoring blanks, duplicates and typed-in markup', () => {
    drawer.addChip('tags', '  #daily ');
    drawer.addChip('tags', 'DAILY');
    drawer.addChip('tags', '   ');
    drawer.addChip('people', '[[Markus]]');

    expect(drawer.tags()).toEqual(['daily']);
    expect(drawer.people()).toEqual(['Markus']);
  });

  it('previews exactly what will be appended', () => {
    drawer.setTopic('Rollout-Sync');
    drawer.setText('Kurzes Sync');
    drawer.addChip('tags', 'daily');
    drawer.addChip('people', 'Markus');

    expect(drawer.preview()).toMatch(
      /^## \d{2}:\d{2} — Rollout-Sync\nKurzes Sync\n#daily · \[\[Markus\]\]$/,
    );
  });

  it('asks before appending when THEMA is empty, and appends on confirmation', async () => {
    drawer.setText('lklk');

    expect(await drawer.submit()).toBe('needs-topic-confirmation');
    expect(drawer.confirmingNoTopic()).toBe(true);
    expect(editor.newEntryRequest().draft).toBeUndefined();

    expect(await drawer.submit(true)).toBe('appended');
    expect(editor.newEntryRequest().draft).toMatchObject({ text: 'lklk' });
  });

  it('appends without asking once THEMA is set', async () => {
    drawer.setTopic('Rollout-Sync');
    drawer.setText('lklk');

    expect(await drawer.submit()).toBe('appended');
    expect(drawer.confirmingNoTopic()).toBe(false);
    expect(editor.newEntryRequest().draft).toMatchObject({ topic: 'Rollout-Sync' });
  });

  it('clears the draft after appending', async () => {
    drawer.setTopic('T');
    drawer.addChip('tags', 'daily');
    await drawer.submit();

    expect(drawer.topic()).toBe('');
    expect(drawer.tags()).toEqual([]);
    expect(drawer.hasContent()).toBe(false);
  });

  it('does nothing at all for an empty draft', async () => {
    expect(await drawer.submit()).toBe('empty');
    expect(drawer.confirmingNoTopic()).toBe(false);
  });

  it('drops the topic prompt as soon as a topic is typed', async () => {
    drawer.setText('x');
    await drawer.submit();
    expect(drawer.confirmingNoTopic()).toBe(true);

    drawer.setTopic('Rollout');
    expect(drawer.confirmingNoTopic()).toBe(false);
  });
});
