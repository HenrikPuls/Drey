import { describe, expect, it } from 'vitest';
import { PENDING_HINT, dialogStarter } from './dialog-starters';

/**
 * The quiet start's texts (req-75): the pre-fill names the processing
 * step and its meaning, and the pending hint says what the wait is.
 */
describe('dialogStarter', () => {
  it('plan: interview first, then propose, then write the ticket', () => {
    expect(dialogStarter('plan')).toBe(
      'Plan step — interview me first, then propose the plan, then write it into the ticket with acceptance criteria.\nMy question: ',
    );
  });

  it('refine: verify with the owner, fix what they approve, record the verdict', () => {
    expect(dialogStarter('refine')).toBe(
      'Refine step — verify the branch against the plan with me, fix what I approve, record the verdict in the ticket Log.\nMy question: ',
    );
  });

  it('both end on the question lead-in, so the owner types right after it', () => {
    expect(dialogStarter('plan').endsWith('My question: ')).toBe(true);
    expect(dialogStarter('refine').endsWith('My question: ')).toBe(true);
  });
});

describe('PENDING_HINT', () => {
  it('names the wait: the worker starts on the first send', () => {
    expect(PENDING_HINT).toBe('waits for your first message — the worker starts when you send');
  });
});
