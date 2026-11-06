import {
  activeSection,
  countSettings,
  filterHitsByScope,
  searchSettings,
  type SettingsSearchSource,
} from './settings-model';

const SOURCES: SettingsSearchSource[] = [
  { id: 'vault', label: 'Vault', hint: 'External change detection', entries: [
    { key: 'vault.watch', label: 'Watch the vault for external changes', description: 'Opt-in file watcher' },
  ] },
  {
    id: 'tickets',
    label: 'Tickets',
    hint: 'Team, flow, budget, devices',
    sections: [{ id: 'budget', label: 'Budget and runners' }],
    entries: [{ key: 'dk.syncSeconds', label: 'Sync interval', description: 'Remote stores only', section: 'budget' }],
  },
];

describe('searchSettings', () => {
  it('finds a setting on another page by label, description or key', () => {
    expect(searchSettings(SOURCES, 'watch').map((h) => h.entry.key)).toEqual(['vault.watch']);
    expect(searchSettings(SOURCES, 'remote stores')[0].categoryId).toBe('tickets');
    expect(searchSettings(SOURCES, 'syncseconds')[0].entry.label).toBe('Sync interval');
  });

  it('needs every word, ignores case, and returns nothing for an empty query', () => {
    expect(searchSettings(SOURCES, 'WATCH nothing')).toEqual([]);
    expect(searchSettings(SOURCES, '   ')).toEqual([]);
  });

  it('matches a page by its label and names the section of an entry', () => {
    expect(searchSettings(SOURCES, 'tickets')[0].entry.key).toBe('');
    expect(searchSettings(SOURCES, 'sync')[0].sectionLabel).toBe('Budget and runners');
  });
});

describe('activeSection', () => {
  const anchors = [
    { id: 'a', top: 0 },
    { id: 'b', top: 400 },
    { id: 'c', top: 900 },
  ];
  it('is the last anchor that reached the top', () => {
    expect(activeSection(anchors, 0, 8)).toBe('a');
    expect(activeSection(anchors, 395, 8)).toBe('b');
    expect(activeSection(anchors, 5000, 8)).toBe('c');
  });
  it('is null without anchors', () => {
    expect(activeSection([], 0, 8)).toBeNull();
  });
});

describe('scope tabs and counts', () => {
  const scoped: SettingsSearchSource[] = [
    { id: 'a', label: 'A', hint: '', entries: [
      { key: 'x', label: 'X', scope: 'device', section: 's' },
      { key: 'y', label: 'Y', scope: 'vault', section: 's' },
      { key: 'z', label: 'Z', section: 't' },
    ] },
  ];
  it('keeps every hit without a tab and only the tab’s scope with one', () => {
    const all = searchSettings([{ ...scoped[0], label: 'q' }].map((s) => ({ ...s, entries: s.entries!.map((e) => ({ ...e, label: `q ${e.label}` })) })), 'q');
    expect(filterHitsByScope(all, null)).toHaveLength(4);
    expect(filterHitsByScope(all, 'device').map((h) => h.entry.key)).toEqual(['x']);
    expect(filterHitsByScope(all, 'all-devices')).toEqual([]);
  });
  it('counts a page’s settings and one section’s', () => {
    expect(countSettings(scoped[0].entries)).toBe(3);
    expect(countSettings(scoped[0].entries, 's')).toBe(2);
    expect(countSettings(undefined)).toBe(0);
  });
});
