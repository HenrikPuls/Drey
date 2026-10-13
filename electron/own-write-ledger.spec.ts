import { OwnWriteLedger } from './own-write-ledger';

/**
 * `electron/own-write-ledger.ts` is IO-free by design (ADR-0045), so it is
 * unit-tested here like the other cross-layer modules. The ledger decides
 * which watcher events are the app's own echoes -- getting this wrong only
 * ever costs a redundant refresh round, never corruption, but the rules
 * themselves (mtime match, prefix rule, TTL, and since ADR-0051 the vault
 * scoping of every key) are worth pinning down.
 */

const V = 'vtest';

describe('OwnWriteLedger', () => {
  let ledger: OwnWriteLedger;

  beforeEach(() => {
    ledger = new OwnWriteLedger();
  });

  describe('content writes (mtime match)', () => {
    it('suppresses an add/change whose mtime matches the recorded write', () => {
      ledger.recordWrite(V, 'notes/a.md', 1_000);
      expect(ledger.isOwnEvent(V, 'notes/a.md', 'change', 1_000)).toBe(true);
      expect(ledger.isOwnEvent(V, 'notes/a.md', 'add', 1_000)).toBe(true);
    });

    it('suppresses within the ±2 ms tolerance', () => {
      ledger.recordWrite(V, 'notes/a.md', 1_000);
      expect(ledger.isOwnEvent(V, 'notes/a.md', 'change', 1_002)).toBe(true);
      expect(ledger.isOwnEvent(V, 'notes/a.md', 'change', 998)).toBe(true);
    });

    it('does not suppress an mtime outside the tolerance', () => {
      ledger.recordWrite(V, 'notes/a.md', 1_000);
      expect(ledger.isOwnEvent(V, 'notes/a.md', 'change', 1_003)).toBe(false);
    });

    it('does not suppress an event without a stat (external bias)', () => {
      ledger.recordWrite(V, 'notes/a.md', 1_000);
      expect(ledger.isOwnEvent(V, 'notes/a.md', 'change', undefined)).toBe(false);
    });

    it('does not suppress a different file', () => {
      ledger.recordWrite(V, 'notes/a.md', 1_000);
      expect(ledger.isOwnEvent(V, 'notes/b.md', 'change', 1_000)).toBe(false);
    });

    it('does not suppress the same relative path in ANOTHER vault', () => {
      ledger.recordWrite('vone', 'notes/a.md', 1_000);
      expect(ledger.isOwnEvent('vtwo', 'notes/a.md', 'change', 1_000)).toBe(false);
    });

    it('keeps the latest write per path', () => {
      ledger.recordWrite(V, 'notes/a.md', 1_000, 10_000);
      ledger.recordWrite(V, 'notes/a.md', 2_000, 20_000);
      expect(ledger.isOwnEvent(V, 'notes/a.md', 'change', 1_000)).toBe(false);
      expect(ledger.isOwnEvent(V, 'notes/a.md', 'change', 2_000)).toBe(true);
    });

    it('matches paths case-insensitively (Windows)', () => {
      ledger.recordWrite(V, 'Notes/A.md', 1_000);
      expect(ledger.isOwnEvent(V, 'notes/a.md', 'change', 1_000)).toBe(true);
    });
  });

  describe('structural ops (TTL + prefix)', () => {
    const t0 = 50_000;

    it('suppresses every event kind at the exact path inside the TTL', () => {
      ledger.recordStructural(V, 'notes/a.md', t0);
      for (const kind of ['add', 'change', 'unlink', 'addDir', 'unlinkDir'] as const) {
        expect(ledger.isOwnEvent(V, 'notes/a.md', kind, undefined, t0 + 100)).toBe(true);
      }
    });

    it('suppresses child events of a recorded folder (prefix rule)', () => {
      ledger.recordStructural(V, 'notes', t0);
      expect(ledger.isOwnEvent(V, 'notes/a.md', 'unlink', undefined, t0 + 100)).toBe(true);
      expect(ledger.isOwnEvent(V, 'notes/sub/b.md', 'add', undefined, t0 + 100)).toBe(true);
    });

    it('does not let a folder record leak across vaults', () => {
      ledger.recordStructural('vone', 'notes', t0);
      expect(ledger.isOwnEvent('vtwo', 'notes/a.md', 'unlink', undefined, t0 + 100)).toBe(false);
    });

    it('does not suppress sibling or partial-prefix paths', () => {
      ledger.recordStructural(V, 'notes', t0);
      expect(ledger.isOwnEvent(V, 'notes-old/a.md', 'unlink', undefined, t0 + 100)).toBe(false);
      expect(ledger.isOwnEvent(V, 'other/a.md', 'unlink', undefined, t0 + 100)).toBe(false);
    });

    it('stops suppressing after the TTL', () => {
      ledger.recordStructural(V, 'notes/a.md', t0);
      expect(ledger.isOwnEvent(V, 'notes/a.md', 'unlink', undefined, t0 + 3_000)).toBe(true);
      expect(ledger.isOwnEvent(V, 'notes/a.md', 'unlink', undefined, t0 + 3_001)).toBe(false);
    });

    it('a live structural record suppresses add/change even with a foreign mtime', () => {
      // The structural record is the more recent fact (the path was just
      // created/copied), so it wins over an mtime that matches nothing.
      ledger.recordStructural(V, 'notes/a.md', t0);
      ledger.recordWrite(V, 'notes/a.md', 1, t0 - 10_000);
      expect(ledger.isOwnEvent(V, 'notes/a.md', 'change', 999, t0 + 100)).toBe(true);
    });
  });

  describe('prune', () => {
    it('drops write entries older than the retention window', () => {
      const t0 = 100_000;
      ledger.recordWrite(V, 'old.md', 5, t0);
      ledger.recordWrite(V, 'new.md', 6, t0 + 40_000);
      ledger.prune(t0 + 60_000);
      expect(ledger.isOwnEvent(V, 'old.md', 'change', 5, t0 + 60_000)).toBe(false);
      expect(ledger.isOwnEvent(V, 'new.md', 'change', 6, t0 + 60_000)).toBe(true);
    });

    it('drops expired structural entries', () => {
      const t0 = 100_000;
      ledger.recordStructural(V, 'gone.md', t0);
      ledger.prune(t0 + 10_000);
      expect(ledger.isOwnEvent(V, 'gone.md', 'unlink', undefined, t0 + 10_000)).toBe(false);
    });
  });
});
