/**
 * Specs for the iPad pane state (req-96): the per-orientation defaults,
 * the localStorage persistence under one key per orientation, the restore
 * on a turn of the device, and the fallbacks for a broken or blocked
 * storage — all against a fake storage and a hand-driven orientation
 * signal, no globals touched.
 */
import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PANES,
  PANES_STORAGE_KEY,
  Panes,
  parsePanes,
  persistPanes,
  storedPanes,
  type Orientation,
} from './panes';

/** A fake storage; `blocked` makes every access throw, like a private window. */
const fakeStorage = (blocked = false): Storage => {
  const values = new Map<string, string>();
  const guard = (): void => {
    if (blocked) {
      throw new Error('storage blocked');
    }
  };
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    key: (i) => [...values.keys()][i] ?? null,
    getItem: (k) => {
      guard();
      return values.get(k) ?? null;
    },
    setItem: (k, v) => {
      guard();
      values.set(k, v);
    },
    removeItem: (k) => void values.delete(k),
  };
};

const makePanes = (storage: Storage | null, start: Orientation = 'landscape') => {
  const orientation = signal<Orientation>(start);
  const panes = new Panes({ storage, orientation: orientation.asReadonly() });
  return { panes, orientation };
};

describe('parsePanes (req-96)', () => {
  it('reads a stored {left, right} pair', () => {
    expect(parsePanes('{"left":false,"right":true}', 'landscape')).toEqual({ left: false, right: true });
  });

  it('falls back to the orientation default on nothing, junk or a wrong shape', () => {
    expect(parsePanes(null, 'landscape')).toEqual(DEFAULT_PANES.landscape);
    expect(parsePanes(null, 'portrait')).toEqual(DEFAULT_PANES.portrait);
    expect(parsePanes('not json', 'portrait')).toEqual(DEFAULT_PANES.portrait);
    expect(parsePanes('"left"', 'landscape')).toEqual(DEFAULT_PANES.landscape);
    expect(parsePanes('{"left":"yes","right":true}', 'landscape')).toEqual(DEFAULT_PANES.landscape);
    expect(parsePanes('{"left":true}', 'portrait')).toEqual(DEFAULT_PANES.portrait);
  });

  it('landscape opens all three panes, portrait the left and the centre', () => {
    expect(DEFAULT_PANES.landscape).toEqual({ left: true, right: true });
    expect(DEFAULT_PANES.portrait).toEqual({ left: true, right: false });
  });
});

describe('storedPanes / persistPanes (req-96)', () => {
  it('writes one key per orientation (decision 31) and reads it back', () => {
    const storage = fakeStorage();
    persistPanes(storage, 'portrait', { left: false, right: true });
    expect(storage.getItem(PANES_STORAGE_KEY.portrait)).toBe('{"left":false,"right":true}');
    expect(storage.getItem(PANES_STORAGE_KEY.landscape)).toBeNull();
    expect(storedPanes(storage, 'portrait')).toEqual({ left: false, right: true });
    expect(storedPanes(storage, 'landscape')).toEqual(DEFAULT_PANES.landscape);
  });

  it('the keys are mc.panes.landscape and mc.panes.portrait', () => {
    expect(PANES_STORAGE_KEY).toEqual({ landscape: 'mc.panes.landscape', portrait: 'mc.panes.portrait' });
  });

  it('a blocked storage reads as the default and swallows the write', () => {
    const storage = fakeStorage(true);
    expect(storedPanes(storage, 'landscape')).toEqual(DEFAULT_PANES.landscape);
    expect(() => persistPanes(storage, 'landscape', { left: false, right: false })).not.toThrow();
    expect(storedPanes(null, 'portrait')).toEqual(DEFAULT_PANES.portrait);
  });
});

describe('Panes (req-96)', () => {
  it('starts with the defaults of the current orientation', () => {
    const { panes, orientation } = makePanes(fakeStorage());
    expect(panes.left()).toBe(true);
    expect(panes.right()).toBe(true);
    orientation.set('portrait');
    expect(panes.left()).toBe(true);
    expect(panes.right()).toBe(false);
  });

  it('a toggle changes only the current orientation and persists it under its key', () => {
    const storage = fakeStorage();
    const { panes, orientation } = makePanes(storage);
    panes.toggleRight();
    expect(panes.right()).toBe(false);
    expect(storage.getItem(PANES_STORAGE_KEY.landscape)).toBe('{"left":true,"right":false}');
    expect(storage.getItem(PANES_STORAGE_KEY.portrait)).toBeNull();
    orientation.set('portrait');
    expect(panes.right()).toBe(false); // the portrait default, not the landscape change
    panes.toggleLeft();
    expect(panes.left()).toBe(false);
    expect(storage.getItem(PANES_STORAGE_KEY.portrait)).toBe('{"left":false,"right":false}');
    orientation.set('landscape');
    expect(panes.left()).toBe(true);
    expect(panes.right()).toBe(false);
  });

  it('restores each orientation from storage on start', () => {
    const storage = fakeStorage();
    persistPanes(storage, 'landscape', { left: false, right: true });
    persistPanes(storage, 'portrait', { left: true, right: true });
    const { panes, orientation } = makePanes(storage, 'portrait');
    expect(panes.current()).toEqual({ left: true, right: true });
    orientation.set('landscape');
    expect(panes.current()).toEqual({ left: false, right: true });
  });

  it('setLeft / setRight are idempotent and keep the other pane', () => {
    const { panes } = makePanes(fakeStorage());
    panes.setLeft(false);
    panes.setLeft(false);
    expect(panes.current()).toEqual({ left: false, right: true });
    panes.setRight(false);
    expect(panes.current()).toEqual({ left: false, right: false });
  });

  it('works without any storage', () => {
    const { panes } = makePanes(null);
    panes.toggleLeft();
    expect(panes.left()).toBe(false);
  });
});
