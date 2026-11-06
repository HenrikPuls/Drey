// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { defaultFaceOf, ticketFaceSwitch, ticketRunActive } from './ticket-faces';
import type { RunInfo } from '../../../packages/tickets-engine/src/fleet/protocol';
import type { BoardSnapshot } from '../shared/tickets';

const phase = (id: string, handover: string): BoardSnapshot['pipeline'][number] =>
  ({ id, title: id, wip: null, claim: false, handover, worker: null, model: null }) as BoardSnapshot['pipeline'][number];

function snapshot(): BoardSnapshot {
  const card = (id: string, phaseId: string): BoardSnapshot['columns'][number]['tickets'][number] =>
    ({
      id,
      path: `tickets/${phaseId}/${id}.md`,
      phase: phaseId,
      meta: { title: id, entered: {}, blockedBy: [], repos: [] },
      worker: 'opencode',
      blocked: [],
      blocks: [],
      issues: [],
    }) as unknown as BoardSnapshot['columns'][number]['tickets'][number];
  const pipeline = [phase('inbox', 'manual'), phase('build', 'agent build'), phase('done', 'none')];
  return {
    columns: [
      { phase: pipeline[0]!, tickets: [card('T-0001', 'inbox')] },
      { phase: pipeline[1]!, tickets: [card('T-0002', 'build')] },
      { phase: pipeline[2]!, tickets: [] },
    ],
    pipeline,
    recentDone: [],
    needs: [],
  } as unknown as BoardSnapshot;
}

const run = (ticketId: string, state: string): RunInfo => ({ id: `r-${ticketId}`, ticketId, state, startedAt: '2026-11-05T10:00:00Z', gateFailure: null, gateResult: null }) as unknown as RunInfo;

describe('the face a ticket opens on (E13-20)', () => {
  it('opens the ticket document before any run', () => {
    expect(ticketRunActive(snapshot(), [], 'T-0001')).toBe(false);
    expect(defaultFaceOf(false)).toBe('ticket');
  });

  it('opens the run while the runner is active', () => {
    expect(ticketRunActive(snapshot(), [run('T-0002', 'running')], 'T-0002')).toBe(true);
    expect(defaultFaceOf(true)).toBe('thread');
  });

  it('opens the ticket again once the run has ended, and without a board', () => {
    expect(ticketRunActive(snapshot(), [run('T-0001', 'done')], 'T-0001')).toBe(false);
    expect(ticketRunActive(null, [run('T-0002', 'running')], 'T-0002')).toBe(false);
  });
});

describe('ticketFaceSwitch (E13-20)', () => {
  const labels = (node: HTMLElement): string[] => [...node.querySelectorAll('button')].map((b) => b.textContent ?? '');
  const selected = (node: HTMLElement): string[] =>
    [...node.querySelectorAll('button')].filter((b) => b.getAttribute('aria-selected') === 'true').map((b) => b.textContent ?? '');

  it('is the same three buttons on every face; only the active one differs', () => {
    const faces = (['ticket', 'thread', 'review'] as const).map((face) => ticketFaceSwitch(face, () => undefined));
    for (const node of faces) {
      expect(labels(node)).toEqual(['Ticket', 'Thread', 'Review']);
      expect(node.className).toBe('seg tickets-faces');
    }
    expect(faces.map(selected)).toEqual([['Ticket'], ['Thread'], ['Review']]);
  });

  it('picks another face on click, and ignores the active one', () => {
    const onPick = vi.fn();
    const node = ticketFaceSwitch('thread', onPick);
    const [ticket, thread, review] = [...node.querySelectorAll('button')];
    thread!.click();
    expect(onPick).not.toHaveBeenCalled();
    review!.click();
    ticket!.click();
    expect(onPick.mock.calls).toEqual([['review'], ['ticket']]);
  });
});
