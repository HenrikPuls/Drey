import { TestBed } from '@angular/core/testing';
import { DreyApi } from '../../../shared/ipc-api';
import { EditorService } from '../services/editor.service';
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

  it('collects tag chips, ignoring blanks, duplicates and a leading #', () => {
    drawer.addChip('  #daily ');
    drawer.addChip('DAILY');
    drawer.addChip('   ');
    drawer.addChip('arbeit');

    expect(drawer.tags()).toEqual(['daily', 'arbeit']);
  });

  it('previews exactly what will be appended', () => {
    drawer.setTopic('Rollout-Sync');
    drawer.setText('Kurzes Sync');
    drawer.addChip('daily');

    expect(drawer.preview()).toMatch(/^## \d{2}:\d{2} — Rollout-Sync\nKurzes Sync\n#daily$/);
  });

  it('appends with no topic, no prompt', async () => {
    drawer.setText('lklk');

    expect(await drawer.submit()).toBe('appended');
    expect(editor.newEntryRequest().draft).toMatchObject({ text: 'lklk', topic: '' });
  });

  it('appends with a topic set', async () => {
    drawer.setTopic('Rollout-Sync');
    drawer.setText('lklk');

    expect(await drawer.submit()).toBe('appended');
    expect(editor.newEntryRequest().draft).toMatchObject({ topic: 'Rollout-Sync' });
  });

  it('clears the draft after appending', async () => {
    drawer.setTopic('T');
    drawer.addChip('daily');
    await drawer.submit();

    expect(drawer.topic()).toBe('');
    expect(drawer.tags()).toEqual([]);
    expect(drawer.hasContent()).toBe(false);
  });

  it('does nothing at all for an empty draft', async () => {
    expect(await drawer.submit()).toBe('empty');
  });

  it('lifts #tags typed in the text into chips', () => {
    drawer.setText('Kurzes Sync mit #projektx und #daily');

    expect(drawer.tags()).toEqual(['projektx', 'daily']);
  });

  it('drops an auto-added chip once its #tag leaves the text', () => {
    drawer.setText('note #projektx');
    expect(drawer.tags()).toEqual(['projektx']);

    drawer.setText('note');
    expect(drawer.tags()).toEqual([]);
  });

  it('converges while a #tag is being typed, leaving no partial chips', () => {
    drawer.setText('note #pr');
    drawer.setText('note #pro');
    drawer.setText('note #proj');

    expect(drawer.tags()).toEqual(['proj']);
  });

  it('keeps a hand-added chip even when it is not in the text', () => {
    drawer.addChip('wichtig');
    drawer.setText('Text ganz ohne dieses Tag');

    expect(drawer.tags()).toEqual(['wichtig']);
  });

  it('keeps a hand-added chip after its #tag is deleted from the text', () => {
    drawer.addChip('daily');
    drawer.setText('heute #daily');
    drawer.setText('heute');

    expect(drawer.tags()).toEqual(['daily']);
  });

  it('does not duplicate a hand-added chip that the text later mentions', () => {
    drawer.addChip('Daily');
    drawer.setText('heute #daily');

    expect(drawer.tags()).toEqual(['Daily']);
  });

  it('removeChip also strips the matching #tag from the text', () => {
    drawer.setText('note #foo bar');

    drawer.removeChip('foo');

    expect(drawer.tags()).toEqual([]);
    expect(drawer.text()).not.toContain('#foo');
  });
});
