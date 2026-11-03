import { describe, expect, it } from 'vitest';
import { normalizePlanBody, withPlanSection } from './plan-section';

const ticket = `---\nid: T-0130\n---\n\n## Description\n\nx\n\n## Plan\n\nold\n\n## Log\n\n- one\n`;

describe('withPlanSection', () => {
  it('replaces only the Plan chapter', () => {
    const out = withPlanSection(ticket, '### Goal\n\nnew');
    expect(out).toBe(`---\nid: T-0130\n---\n\n## Description\n\nx\n\n## Plan\n\n### Goal\n\nnew\n\n## Log\n\n- one\n`);
  });

  it('is stable when the plan does not change', () => {
    const once = withPlanSection(ticket, 'same');
    expect(withPlanSection(once, 'same')).toBe(once);
  });

  it('adds a Plan before the Log when there is none', () => {
    const out = withPlanSection('---\nid: T-1\n---\n\n## Description\n\nx\n\n## Log\n\n- one\n', 'fresh');
    expect(out).toContain('## Description\n\nx\n\n## Plan\n\nfresh\n\n## Log');
  });

  it('adds a Plan at the end when there is no Log either', () => {
    expect(withPlanSection('---\nid: T-1\n---\n\n## Description\n\nx\n', 'fresh')).toBe('---\nid: T-1\n---\n\n## Description\n\nx\n\n## Plan\n\nfresh\n');
  });

  it('writes the Plan at the end of a file that ends in it', () => {
    expect(withPlanSection('## Description\n\nx\n\n## Plan\n\nold\n', 'new')).toBe('## Description\n\nx\n\n## Plan\n\nnew\n');
  });

  it('demotes a level-2 heading in the body so it cannot swallow the next chapter', () => {
    const out = withPlanSection(ticket, 'a\n\n## Log\n\nsneaky');
    expect(out.match(/^## Log$/gm)).toHaveLength(1);
    expect(out).toContain('### Log\n\nsneaky');
  });

  it('reads CRLF files and writes LF', () => {
    expect(withPlanSection(ticket.replace(/\n/g, '\r\n'), 'x')).not.toContain('\r');
  });
});

describe('normalizePlanBody', () => {
  it('drops an own "## Plan" heading and trims', () => {
    expect(normalizePlanBody('\n## Plan\n\n### Goal\n\nx\n\n')).toBe('### Goal\n\nx');
  });
});
