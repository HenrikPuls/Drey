// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { RunWaiting } from '../main/fleet/protocol';
import { answerText } from '../shared/question-shape';
import { questionNode } from './wait-view';

/** req-75 W2b: the waiting question as part of the conversation — the
 *  lead-in, the why, the option pills and the meta line of the canvas,
 *  and the one-tap answer that disables the pills. */

const NOW = Date.parse('2026-10-31T10:04:00Z');

const shaped = (over: Partial<NonNullable<RunWaiting['shaped']>> = {}): RunWaiting =>
  ({
    kind: 'question',
    text: 'Which database?',
    since: '2026-10-31T10:00:00Z',
    shaped: {
      question: 'Should dragging a heading also move the text below it?',
      context: 'the outline plugin',
      where: 'step 2 of 4',
      why: 'The plan says reorder headings but not whether the text under one moves along.',
      options: [
        { n: 1, label: 'Move the whole section', consequence: 'one undo step, what other editors do' },
        { n: 2, label: 'Only the heading line', consequence: 'text stays, structure usually breaks' },
      ],
      recommended: 1,
      recommendationWhy: 'every other editor moves the section',
      ...over,
    },
  }) as RunWaiting;

describe('questionNode — the shaped question reads like the canvas', () => {
  it('renders the lead-in, the bold question, the why, the pills and the meta line', () => {
    const node = questionNode({ onPick: () => undefined, disabled: false }, shaped(), NOW, 0);
    expect(node.querySelector('.tickets-ask-lead')?.textContent).toBe(
      'One decision before I go on: Should dragging a heading also move the text below it?',
    );
    const question = node.querySelector('.tickets-ask-question');
    expect(question?.textContent).toBe('Should dragging a heading also move the text below it?');
    expect(question?.tagName).toBe('B');
    expect(node.querySelector('.tickets-ask-why')?.textContent).toBe(
      'The plan says reorder headings but not whether the text under one moves along.',
    );
    // The desk shows the conversation only — the ticket and step lines
    // stay out (the phone keeps them).
    expect(node.textContent).not.toContain('Ticket:');
    expect(node.textContent).not.toContain('Where:');
    expect(node.querySelector('.tickets-ask-meta')?.textContent).toBe('4 min ago · the worker waits, nothing else is blocked');
  });

  it('one pill per option — label and consequence one text, the recommended one marked', () => {
    const node = questionNode({ onPick: () => undefined, disabled: false }, shaped(), NOW, 0);
    const pills = [...node.querySelectorAll<HTMLButtonElement>('.tickets-ask-options .tickets-pill')];
    expect(pills).toHaveLength(2);
    const [first, second] = pills;
    expect(first?.classList.contains('tickets-pill-recommended')).toBe(true);
    expect(first?.querySelector('.tickets-pill-label')?.textContent).toBe('Move the whole section');
    expect(first?.querySelector('.tickets-pill-why')?.textContent).toBe(' — one undo step, what other editors do');
    expect(first?.querySelector('.tickets-pill-flag')?.textContent).toBe('recommended');
    // The recommendation's reason moved into the recommended pill's title.
    expect(first?.title).toBe('every other editor moves the section');
    expect(second?.classList.contains('tickets-pill-recommended')).toBe(false);
    expect(second?.querySelector('.tickets-pill-flag')).toBeNull();
    expect(second?.title).toBe('text stays, structure usually breaks');
    expect(pills.every((p) => p instanceof HTMLButtonElement)).toBe(true);
  });

  it('leaves the why paragraph out when the shape names none', () => {
    const node = questionNode({ onPick: () => undefined, disabled: false }, shaped({ why: null }), NOW, 0);
    expect(node.querySelector('.tickets-ask-why')).toBeNull();
  });

  it('says when other workers keep going — one or many', () => {
    const meta = (others: number): string | null =>
      questionNode({ onPick: () => undefined, disabled: false }, shaped(), NOW, others).querySelector('.tickets-ask-meta')?.textContent ?? null;
    expect(meta(1)).toBe('4 min ago · the worker waits; 1 other worker keeps going');
    expect(meta(2)).toBe('4 min ago · the worker waits; 2 other workers keep going');
  });

  it('ages from the wait: minutes under the hour, hours above', () => {
    const meta = (since: string): string | null =>
      questionNode({ onPick: () => undefined, disabled: false }, { ...shaped(), since }, NOW, 0).querySelector('.tickets-ask-meta')
        ?.textContent ?? null;
    expect(meta('2026-10-31T10:03:00Z')).toBe('1 min ago · the worker waits, nothing else is blocked');
    expect(meta('2026-10-31T08:04:00Z')).toBe('2 h ago · the worker waits, nothing else is blocked');
  });
});

describe('questionNode — a plain question still renders', () => {
  it('shows its lead-in and text, no pills, no why', () => {
    const node = questionNode(
      { onPick: () => undefined, disabled: false },
      { kind: 'question', text: 'Which API?', since: '2026-10-31T10:03:00Z' },
      NOW,
      0,
    );
    expect(node.querySelector('.tickets-ask-lead')?.textContent).toBe('The worker asks: Which API?');
    const question = node.querySelector('.tickets-ask-question');
    expect(question?.textContent).toBe('Which API?');
    expect(question?.tagName).toBe('SPAN');
    expect(node.querySelectorAll('.tickets-pill')).toHaveLength(0);
    expect(node.querySelector('.tickets-ask-why')).toBeNull();
    expect(node.querySelector('.tickets-ask-meta')?.textContent).toBe('1 min ago · the worker waits, nothing else is blocked');
  });
});

describe('questionNode — picking an option answers', () => {
  it('calls onPick with answerText(option) and disables the pills', () => {
    const onPick = vi.fn();
    const node = questionNode({ onPick, disabled: false }, shaped(), NOW, 0);
    const pills = [...node.querySelectorAll<HTMLButtonElement>('.tickets-pill')];
    pills[1]?.click();
    expect(onPick).toHaveBeenCalledWith(answerText(shaped().shaped!.options[1]!));
    expect(pills.map((p) => p.disabled)).toEqual([true, true]);
  });

  it('paints the pills disabled while an answer is under way', () => {
    const node = questionNode({ onPick: () => undefined, disabled: true }, shaped(), NOW, 0);
    expect([...node.querySelectorAll<HTMLButtonElement>('.tickets-pill')].every((p) => p.disabled)).toBe(true);
  });
});
