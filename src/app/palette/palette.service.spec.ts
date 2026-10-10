import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { VaultFileEntry } from '../../../shared/ipc-api';
import { KeybindingService } from '../keybindings';
import { DocHistoryService } from '../services/doc-history.service';
import { EditorService } from '../services/editor.service';
import { VaultService } from '../vault';
import { PaletteService, formatChord } from './palette.service';

const file = (relativePath: string): VaultFileEntry => ({
  name: relativePath.slice(relativePath.lastIndexOf('/') + 1),
  relativePath,
  type: 'file',
});

describe('PaletteService', () => {
  let service: PaletteService;
  let keys: KeybindingService;
  const openFile = vi.fn().mockResolvedValue(undefined);
  const createEntry = vi.fn().mockResolvedValue(undefined);
  const recent = signal<string[]>([]);
  const active = signal<string | null>(null);

  beforeEach(() => {
    openFile.mockClear();
    createEntry.mockClear();
    recent.set([]);
    active.set(null);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: VaultService,
          useValue: {
            vaults: signal([{ id: 'v1', name: 'Main', path: '/v', active: true }]),
            trees: signal({
              v1: [
                file('alpha.md'),
                { name: 'proj', relativePath: 'proj', type: 'directory', children: [file('proj/plan.md')] },
                file('beta.md'),
              ],
            }),
            activeVaultId: signal('v1'),
            createEntry,
          },
        },
        {
          provide: EditorService,
          useValue: { openFile, activePath: active, error: signal<string | null>(null) },
        },
        { provide: DocHistoryService, useValue: { recentKeys: () => recent() } },
      ],
    });
    service = TestBed.inject(PaletteService);
    keys = TestBed.inject(KeybindingService);
  });

  it('lists files with visited documents first, the one on screen excluded from the lead', () => {
    recent.set(['v1::beta.md', 'v1::alpha.md']);
    active.set('v1::beta.md');
    service.show('files');
    expect(service.items().map((i) => i.label)).toEqual(['alpha.md', 'plan.md', 'beta.md']);
  });

  it('filters by name before path and opens the pick', () => {
    service.show('files');
    service.query.set('plan');
    const [first] = service.items();
    expect(first.label).toBe('plan.md');
    expect(first.detail).toBe('proj');
    service.run(first, true);
    expect(openFile).toHaveBeenCalledWith('proj/plan.md', 'v1', { keepFocused: true });
    expect(service.open()).toBe(false);
  });

  it('offers to create a note when nothing matches', async () => {
    service.show('files');
    service.query.set('Brand new');
    const [only] = service.items();
    expect(only.label).toBe('Create note "Brand new"');
    service.run(only, false);
    await Promise.resolve();
    await Promise.resolve();
    expect(createEntry).toHaveBeenCalledWith('file', 'Brand new.md', 'v1');
    expect(openFile).toHaveBeenCalledWith('Brand new.md', 'v1');
  });

  it('lists commands behind a leading >, without its own openers', () => {
    const ran: string[] = [];
    keys.register({ id: 't.save', label: 'Save', keybinding: 'Mod+S', run: () => ran.push('save') });
    keys.register({ id: 'palette.files', label: 'Go to file…', run: () => ran.push('self') });
    service.show('commands');
    expect(service.query()).toBe('>');
    expect(service.mode()).toBe('commands');
    service.query.set('> sav');
    const items = service.items();
    expect(items.map((i) => i.id)).toEqual(['t.save']);
    service.run(items[0], false);
    expect(ran).toEqual(['save']);
  });

  it('prints chords the way the menus do', () => {
    expect(formatChord('Alt+ArrowLeft')).toBe('Alt Left');
    expect(formatChord('Shift+F6')).toBe('Shift F6');
    expect(formatChord(undefined)).toBe('');
  });
});
