/**
 * The pure half of "a worker waits for you" (req-64): which waits in a
 * fleet snapshot are new to this window and what their notification says.
 * The board calls it on every snapshot; `seen` remembers what it already
 * announced, so a wait is announced once — and again only when the worker
 * asks anew.
 */
import type { RunInfo } from '../main/fleet/protocol';

export interface WaitNotice {
  readonly run: RunInfo;
  readonly title: string;
  readonly body: string;
}

const LIVE: readonly string[] = ['starting', 'running', 'stopping'];

/** The waits of `runs` not in `seen` yet; adds them to `seen` and forgets ended ones. */
export function newWaits(runs: readonly RunInfo[], seen: Set<string>): readonly WaitNotice[] {
  const current = new Set<string>();
  const notices: WaitNotice[] = [];
  for (const run of runs) {
    const waiting = run.waiting ?? null;
    if (waiting === null || !LIVE.includes(run.state)) {
      continue;
    }
    const key = `${run.id}@${waiting.since}`;
    current.add(key);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const text = waiting.text.length > 200 ? `${waiting.text.slice(0, 199)}…` : waiting.text;
    notices.push({
      run,
      title: waiting.kind === 'question' ? `${run.ticketId} asks you` : `${run.ticketId} needs your approval`,
      body: text,
    });
  }
  for (const key of [...seen]) {
    if (!current.has(key)) {
      seen.delete(key);
    }
  }
  return notices;
}
