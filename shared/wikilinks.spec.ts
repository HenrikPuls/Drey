import { describe, expect, it } from 'vitest';
import { buildNoteIndex, resolveWikilinkAcrossVaults } from './wikilinks';
import type { VaultNoteIndex } from './wikilinks';

const own: VaultNoteIndex = { vaultId: 'notes', index: buildNoteIndex(['plan.md', 'daily/journal.md']) };
const tickets: VaultNoteIndex = {
  vaultId: 'tickets',
  index: buildNoteIndex(['tickets/T-0063.md', 'plan.md']),
};
const archive: VaultNoteIndex = { vaultId: 'archive', index: buildNoteIndex(['old/T-0063.md']) };

describe('resolveWikilinkAcrossVaults', () => {
  it("resolves in the link's own vault first, even when another vault has the name too", () => {
    const hit = resolveWikilinkAcrossVaults('plan', 'notes', null, [tickets, own], true);
    expect(hit).toEqual({ vaultId: 'notes', path: 'plan.md', fallback: false, alsoIn: [] });
  });

  it('does not search other vaults when the fallback is off', () => {
    expect(resolveWikilinkAcrossVaults('T-0063', 'notes', null, [own, tickets], false)).toBeNull();
  });

  it('falls back to another vault only when the own vault has no match', () => {
    const hit = resolveWikilinkAcrossVaults('T-0063', 'notes', null, [own, tickets], true);
    expect(hit).toEqual({
      vaultId: 'tickets',
      path: 'tickets/T-0063.md',
      fallback: true,
      alsoIn: [],
    });
  });

  it('opens the first match in the given order and lists the other vaults as ambiguous', () => {
    const hit = resolveWikilinkAcrossVaults('T-0063', 'notes', null, [archive, own, tickets], true);
    expect(hit).toMatchObject({ vaultId: 'archive', path: 'old/T-0063.md', alsoIn: ['tickets'] });
    const reversed = resolveWikilinkAcrossVaults('T-0063', 'notes', null, [tickets, own, archive], true);
    expect(reversed).toMatchObject({ vaultId: 'tickets', alsoIn: ['archive'] });
  });

  it('applies the usual rules inside a fallback vault (path targets work too)', () => {
    const hit = resolveWikilinkAcrossVaults('tickets/T-0063', 'notes', null, [own, tickets], true);
    expect(hit?.path).toBe('tickets/T-0063.md');
  });

  it('never treats an empty target as a fallback candidate', () => {
    expect(resolveWikilinkAcrossVaults('', 'notes', null, [own, tickets], true)).toBeNull();
  });

  it('finds nothing when no vault matches', () => {
    expect(resolveWikilinkAcrossVaults('nope', 'notes', null, [own, tickets, archive], true)).toBeNull();
  });
});
