import { describe, expect, it } from 'vitest';
import { DEFAULT_PRIORITY_CONFIG, priorityClass, priorityWeight, type PriorityConfig } from './tickets';

/**
 * The cross-layer mirror (ADR-0076) re-exports the contracts package —
 * this spec only pins that the priority vocabulary API (M111) is
 * reachable from here, the module the renderer bundle imports: the Work
 * panel's sorts and the display chips read exactly these names.
 */
describe('the mirror exposes the priority vocabulary API', () => {
  it('the default config and both helpers come through with contract behaviour', () => {
    expect(DEFAULT_PRIORITY_CONFIG.order).toEqual(['urgent', 'high', 'normal', 'low']);
    expect(DEFAULT_PRIORITY_CONFIG.default).toBe('normal');
    const configured: PriorityConfig = { order: ['p0', 'p1', 'p2', 'p3'], default: 'p2' };
    expect(priorityWeight('p2', configured)).toBe(2);
    expect(priorityWeight('nope', configured)).toBe(4);
    expect(priorityWeight('urgent')).toBe(0);
    expect(priorityClass('p0', configured)).toBe(0);
    expect(priorityClass('p2', configured)).toBe(1);
    expect(priorityClass('urgent')).toBe(0);
    expect(priorityClass('nope', configured)).toBe(1);
  });
});
