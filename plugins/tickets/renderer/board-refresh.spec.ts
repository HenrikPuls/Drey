import { describe, expect, it } from 'vitest';
import { createBoardRefresh, createChangeGate } from './board-refresh';

interface Board {
  readonly columns: readonly { readonly id: string; readonly tickets: readonly string[] }[];
}

const BOARD: Board = { columns: [{ id: 'inbox', tickets: ['T-1'] }] };

function harness(first: Board | Error) {
  let answer: Board | Error = first;
  let note = '';
  const boards: Board[] = [];
  let repaints = 0;
  let reads = 0;
  const refresh = createBoardRefresh<Board>({
    read: () => {
      reads += 1;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    onBoard: (board) => boards.push(board),
    onRead: () => {
      note = '';
    },
    onFailure: (error) => {
      note = (error as Error).message;
    },
    note: () => note,
    repaint: () => {
      repaints += 1;
    },
  });
  return {
    refresh,
    boards,
    answer: (next: Board | Error) => {
      answer = next;
    },
    repaints: () => repaints,
    reads: () => reads,
    note: () => note,
  };
}

describe('the board refresh round (D-40)', () => {
  it('a refresh that changes nothing rebuilds nothing', async () => {
    const h = harness(BOARD);
    await h.refresh();
    expect(h.repaints()).toBe(1);
    expect(h.boards).toHaveLength(1);

    // The engine's first board-changed and vault events after a start: same board, equal copies.
    for (let i = 0; i < 5; i += 1) {
      h.answer(JSON.parse(JSON.stringify(BOARD)) as Board);
      await h.refresh();
    }
    expect(h.reads()).toBe(6);
    expect(h.repaints()).toBe(1);
    expect(h.boards).toHaveLength(1);
  });

  it('a refresh that brings a change repaints once, not twice', async () => {
    const h = harness(BOARD);
    await h.refresh();
    h.answer({ columns: [{ id: 'inbox', tickets: ['T-1', 'T-2'] }] });
    await h.refresh();
    expect(h.repaints()).toBe(2);
    expect(h.boards.at(-1)?.columns[0]?.tickets).toEqual(['T-1', 'T-2']);
  });

  it('a failure shows, its repeat does not rebuild, the next good read clears it', async () => {
    const h = harness(BOARD);
    await h.refresh();
    h.answer(new Error('the engine is gone'));
    await h.refresh();
    expect(h.note()).toBe('the engine is gone');
    expect(h.repaints()).toBe(2);
    await h.refresh();
    expect(h.repaints()).toBe(2);

    h.answer(BOARD);
    await h.refresh();
    expect(h.note()).toBe('');
    expect(h.repaints()).toBe(3);
  });

  it('runs one round at a time', async () => {
    const h = harness(BOARD);
    const first = h.refresh();
    expect(h.refresh()).toBe(first);
    await first;
    expect(h.reads()).toBe(1);
  });
});

describe('createChangeGate', () => {
  it('passes the first value and every different one, by content', () => {
    const changed = createChangeGate();
    expect(changed([{ id: 'a' }])).toBe(true);
    expect(changed([{ id: 'a' }])).toBe(false);
    expect(changed([{ id: 'b' }])).toBe(true);
    expect(changed(null)).toBe(true);
    expect(changed(null)).toBe(false);
  });
});
