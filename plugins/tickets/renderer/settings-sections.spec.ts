import { TICKETS_ENTRIES, TICKETS_SECTIONS } from './settings-sections';

describe('Settings -> Tickets sections (E13-22)', () => {
  it('has unique section ids and every entry points at a declared section', () => {
    const ids = TICKETS_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of TICKETS_ENTRIES) {
      expect(ids, entry.key).toContain(entry.section);
    }
  });

  it('has unique entry keys', () => {
    const keys = TICKETS_ENTRIES.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
