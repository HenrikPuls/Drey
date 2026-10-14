import type { KeybindingsConfig } from '../../../../shared/app-config';
import {
  assignChord,
  CAPTURE_ROW_ID,
  conflictingIds,
  holderOf,
  replaceChord,
  resetChord,
  shortcutRows,
  type CommandDefault,
} from './shortcut-model';

const commands: CommandDefault[] = [
  { id: 'note.save', label: 'Save', defaultChord: 'Mod+S' },
  { id: 'note.new', label: 'New note', defaultChord: 'Mod+N' },
  { id: 'note.exportPdf', label: 'Export as PDF…', defaultChord: undefined },
];

const fresh = (): KeybindingsConfig => ({ overrides: {}, capture: 'Mod+Alt+N' });

const row = (config: KeybindingsConfig, id: string) =>
  shortcutRows(commands, config).find((r) => r.id === id)!;

describe('shortcutRows', () => {
  it('puts the quick-capture row first, then the commands by label', () => {
    const rows = shortcutRows(commands, fresh());
    expect(rows.map((r) => r.id)).toEqual([CAPTURE_ROW_ID, 'note.exportPdf', 'note.new', 'note.save']);
    expect(rows[0]).toMatchObject({ chord: 'Mod+Alt+N', changed: false });
  });

  it('shows the override in effect and marks the row changed', () => {
    const config: KeybindingsConfig = { overrides: { 'note.save': null }, capture: null };
    expect(row(config, 'note.save')).toMatchObject({ chord: undefined, changed: true });
    expect(row(config, CAPTURE_ROW_ID)).toMatchObject({ chord: undefined, changed: true });
  });
});

describe('holderOf / conflictingIds', () => {
  it('finds the row that holds a chord, whatever its spelling', () => {
    const rows = shortcutRows(commands, fresh());
    expect(holderOf(rows, 'ctrl+s', 'note.new')?.id).toBe('note.save');
    expect(holderOf(rows, 'Mod+S', 'note.save')).toBeUndefined();
    expect(holderOf(rows, 'Ctrl+Alt+N', 'note.new')?.id).toBe(CAPTURE_ROW_ID);
  });

  it('reports rows that share a chord', () => {
    const config: KeybindingsConfig = { overrides: {}, capture: 'Mod+N' };
    expect([...conflictingIds(shortcutRows(commands, config))].sort()).toEqual([
      CAPTURE_ROW_ID,
      'note.new',
    ]);
  });
});

describe('assignChord / resetChord / replaceChord', () => {
  it('stores a new chord canonically and drops an override equal to the default', () => {
    let config = assignChord(fresh(), row(fresh(), 'note.new'), 'shift+ctrl+k');
    expect(config.overrides).toEqual({ 'note.new': 'Mod+Shift+K' });
    config = assignChord(config, row(config, 'note.new'), 'Mod+N');
    expect(config.overrides).toEqual({});
  });

  it('removes a chord as null and resets back to the default', () => {
    let config = assignChord(fresh(), row(fresh(), 'note.save'), null);
    expect(config.overrides).toEqual({ 'note.save': null });
    config = resetChord(config, row(config, 'note.save'));
    expect(config.overrides).toEqual({});
  });

  it('assigns, removes and resets the quick-capture hotkey', () => {
    const capture = row(fresh(), CAPTURE_ROW_ID);
    expect(assignChord(fresh(), capture, 'Mod+Alt+Q').capture).toBe('Mod+Alt+Q');
    expect(assignChord(fresh(), capture, null).capture).toBeNull();
    expect(resetChord({ overrides: {}, capture: null }, capture).capture).toBe('Mod+Alt+N');
  });

  it('replace gives the chord to the target and leaves the holder without one', () => {
    const config = replaceChord(fresh(), row(fresh(), 'note.new'), row(fresh(), 'note.save'), 'Mod+S');
    expect(config.overrides).toEqual({ 'note.save': null, 'note.new': 'Mod+S' });
    const rows = shortcutRows(commands, config);
    expect(conflictingIds(rows).size).toBe(0);
  });
});
