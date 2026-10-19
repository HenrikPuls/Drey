import { describe, expect, it } from 'vitest';
import { canMove, dropIndex, folderNumber, moveItem } from './settings-order';

const PHASES = ['inbox', 'prioritized', 'plan', 'build', 'review', 'done'];

describe('canMove', () => {
  it('lets the middle rows move anywhere between the pinned ends', () => {
    expect(canMove(PHASES.length, 2, 1)).toBe(true);
    expect(canMove(PHASES.length, 1, 4)).toBe(true);
  });

  it('pins the first and the last row, and refuses a move onto them or a no-op', () => {
    expect(canMove(PHASES.length, 0, 2)).toBe(false);
    expect(canMove(PHASES.length, 5, 2)).toBe(false);
    expect(canMove(PHASES.length, 2, 0)).toBe(false);
    expect(canMove(PHASES.length, 2, 5)).toBe(false);
    expect(canMove(PHASES.length, 2, 2)).toBe(false);
    expect(canMove(2, 0, 1)).toBe(false);
  });
});

describe('moveItem', () => {
  it('moves one entry and leaves the input alone', () => {
    expect(moveItem(PHASES, 4, 2)).toEqual(['inbox', 'prioritized', 'review', 'plan', 'build', 'done']);
    expect(moveItem(PHASES, 1, 3)).toEqual(['inbox', 'plan', 'build', 'prioritized', 'review', 'done']);
    expect(PHASES[1]).toBe('prioritized');
  });
});

describe('dropIndex', () => {
  const mids = [10, 30, 50, 70, 90, 110];

  it('lands above the first row whose midpoint is below the pointer', () => {
    expect(dropIndex(mids, 45, 4)).toBe(2);
    expect(dropIndex(mids, 80, 1)).toBe(3);
  });

  it('clamps into the movable band', () => {
    expect(dropIndex(mids, 0, 3)).toBe(1);
    expect(dropIndex(mids, 500, 2)).toBe(4);
  });
});

describe('folderNumber', () => {
  it('is the 1-based position times ten, two digits at least', () => {
    expect(folderNumber(0)).toBe('10');
    expect(folderNumber(7)).toBe('80');
    expect(folderNumber(11)).toBe('120');
  });
});
