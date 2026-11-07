/**
 * The board's refresh round (D-40). The engine's events, the vault's and every mutation ask
 * for a fresh board, most of them finding what the views already show; a repaint rebuilds the
 * Work header's chip and the Board's columns, and could cost a click or a focused card for
 * nothing. So a round repaints only when it brought something new.
 */

/** Whether a value differs from the last one it saw; the first one always does. Values are plain JSON. */
export function createChangeGate(): (value: unknown) => boolean {
  let last: string | null = null;
  return (value) => {
    const text = JSON.stringify(value) ?? '';
    if (text === last) {
      return false;
    }
    last = text;
    return true;
  };
}

export interface BoardRefreshDeps<B> {
  readonly read: () => Promise<B>;
  /** A board that differs from the one before: take it. */
  readonly onBoard: (board: B) => void;
  /** After every good read, changed or not: what clears the last load error and starts the rounds beside the board. */
  readonly onRead: () => void;
  readonly onFailure: (error: unknown) => void;
  /** The board's message: a round that changes it repaints too. */
  readonly note: () => string;
  readonly repaint: () => void;
}

/** One round at a time: a call while one runs waits for that one. */
export function createBoardRefresh<B>(deps: BoardRefreshDeps<B>): () => Promise<void> {
  const boardChanged = createChangeGate();
  let inFlight: Promise<void> | null = null;
  return () => {
    if (inFlight !== null) {
      return inFlight;
    }
    inFlight = (async () => {
      const noteBefore = deps.note();
      let changed = false;
      try {
        const board = await deps.read();
        changed = boardChanged(board);
        if (changed) {
          deps.onBoard(board);
        }
        deps.onRead();
      } catch (error) {
        deps.onFailure(error);
      } finally {
        inFlight = null;
      }
      if (changed || deps.note() !== noteBefore) {
        deps.repaint();
      }
    })();
    return inFlight;
  };
}
