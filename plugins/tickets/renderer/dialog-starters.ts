import type { InteractiveMode } from './end-moves';

/**
 * The thread composer's quiet start (req-75): nothing runs until the
 * owner asks, so the prompt box opens pre-filled with the current
 * processing step and its meaning — the owner completes it with their
 * question and sends. Pure text, pinned by the spec beside it.
 */
export function dialogStarter(mode: InteractiveMode): string {
  return mode === 'plan'
    ? 'Plan step — interview me first, then propose the plan, then write it into the ticket with acceptance criteria.\nMy question: '
    : 'Refine step — verify the branch against the plan with me, fix what I approve, record the verdict in the ticket Log.\nMy question: ';
}

/**
 * Under the thread's status line while a quiet run stands (req-75):
 * the worker exists, but nothing happens until the first message.
 */
export const PENDING_HINT = 'waits for your first message — the worker starts when you send';
