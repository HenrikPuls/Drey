import { expect, vi } from 'vitest';
import type { RunState } from './protocol';
import type { RunSupervisor } from './runs';

/**
 * Shared by the RunSupervisor specs (`runs.spec.ts`, `runs-dk.spec.ts`).
 *
 * `state` turns terminal in memory BEFORE the settle has written the
 * ticket (stamp cleared, log line, commit, persona memory), so a spec that
 * waits on `state` alone and then reads the ticket races the settle, and a
 * spec that ends right after races its `afterEach` cleanup (the D-4 flake).
 * `onRunSettled` fires as the settle's very last step: waiting on that
 * event is waiting for the whole settle, with no clock in it.
 */
const settledRuns = new WeakMap<RunSupervisor, Set<string>>();
const settleWaiters = new WeakMap<RunSupervisor, Map<string, (() => void)[]>>();
const built: RunSupervisor[] = [];

/** Registers a supervisor the spec built: its settles are awaitable and `drainSupervisors` waits for its background work. */
export function trackSupervisor(sup: RunSupervisor): void {
  settledRuns.set(sup, new Set());
  settleWaiters.set(sup, new Map());
  built.push(sup);
}

/** Call from the supervisor's `onRunSettled`. */
export function markSettled(sup: RunSupervisor, id: string): void {
  settledRuns.get(sup)?.add(id);
  for (const wake of settleWaiters.get(sup)?.get(id) ?? []) {
    wake();
  }
}

export function hasSettled(sup: RunSupervisor, id: string): boolean {
  return settledRuns.get(sup)?.has(id) === true;
}

/** Waits for the run's settle to finish — the event, not a poll against a clock — then checks its state. */
export async function settled(sup: RunSupervisor, id: string, state: RunState): Promise<void> {
  if (!hasSettled(sup, id)) {
    await new Promise<void>((resolve) => {
      const waiters = settleWaiters.get(sup)!;
      waiters.set(id, [...(waiters.get(id) ?? []), resolve]);
    });
  }
  expect(sup.get(id)?.state).toBe(state);
}

/**
 * `vi.waitFor` polls with a 1 s ceiling by default, shorter than the 5 s
 * the test itself gets, so a starved machine failed the poll while the
 * test still had time. The test's own timeout is the one budget.
 */
export function waitFor<T>(callback: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(callback, { timeout: 5000, interval: 10 });
}

/** Waits for the background work of every supervisor the spec built; call before a temp dir is removed. */
export async function drainSupervisors(): Promise<void> {
  for (const sup of built.splice(0)) {
    await sup.idle();
  }
}
