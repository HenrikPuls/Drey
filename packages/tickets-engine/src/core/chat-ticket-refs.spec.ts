import { describe, expect, it } from 'vitest';
import { ticketRefsOf } from './chat-ticket-refs';

describe('ticketRefsOf (D-7: the ticket ids an owner types)', () => {
  it('reads T-0091, t-91 and #91 as the same canonical id', () => {
    expect(ticketRefsOf('what is T-0091 doing?')).toEqual(['T-0091']);
    expect(ticketRefsOf('status of t-91')).toEqual(['T-0091']);
    expect(ticketRefsOf('and #91?')).toEqual(['T-0091']);
    expect(ticketRefsOf('#91')).toEqual(['T-0091']);
  });

  it('keeps ids of more than four digits and drops duplicates in order', () => {
    expect(ticketRefsOf('T-12345 then T-0002, t-2 and #2 again, T-0001')).toEqual(['T-12345', 'T-0002', 'T-0001']);
  });

  it('does not read words, versions, colors or numbers as ids', () => {
    expect(ticketRefsOf('use #fff and v2.91 and 91 apples, ST-91, foo#91, T-')).toEqual([]);
    expect(ticketRefsOf('')).toEqual([]);
  });

  it('caps the list so a pasted log cannot flood the prompt', () => {
    const many = Array.from({ length: 12 }, (_, i) => `T-${String(100 + i).padStart(4, '0')}`).join(' ');
    expect(ticketRefsOf(many)).toHaveLength(5);
  });
});
