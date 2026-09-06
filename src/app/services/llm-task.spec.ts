import { TestBed } from '@angular/core/testing';
import { DreyApi } from '../../../shared/ipc-api';
import { LlmTaskService } from './llm-task.service';

describe('LlmTaskService', () => {
  let tasks: LlmTaskService;
  let cancelled: string[];

  beforeEach(() => {
    cancelled = [];
    window.dreyApi = {
      cancelLlmTask: (taskId: string) => {
        cancelled.push(taskId);
        return Promise.resolve(true);
      },
    } as unknown as DreyApi;
    tasks = TestBed.inject(LlmTaskService);
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  it('tracks a run and reports how long it took', async () => {
    let seenId = '';
    const { value, durationMs } = await tasks.run('Summarising', async (taskId) => {
      seenId = taskId;
      expect(tasks.isRunning()).toBe(true);
      expect(tasks.currentLabel()).toMatch(/^Summarising · thinking \d+s$/);
      return 'done';
    });

    expect(value).toBe('done');
    expect(seenId).not.toBe('');
    expect(durationMs).toBeGreaterThanOrEqual(0);
    expect(tasks.isRunning()).toBe(false);
    expect(tasks.currentLabel()).toBeNull();
  });

  it('gives the work its task id before the call resolves, so Cancel can reach it', async () => {
    let idDuringCall = '';
    await tasks.run('Thinking', async (taskId) => {
      idDuringCall = taskId;
      // Cancel while the "request" is still outstanding -- the whole point
      // of minting the id in the renderer.
      await tasks.cancel();
      return null;
    });

    expect(cancelled).toEqual([idDuringCall]);
  });

  it('stops tracking a run that threw, and still reports nothing running', async () => {
    await expect(tasks.run('Thinking', () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    expect(tasks.isRunning()).toBe(false);
  });

  it('cancels a specific task by id', async () => {
    await tasks.cancel('task-42');
    expect(cancelled).toEqual(['task-42']);
  });

  it('does nothing when there is nothing to cancel', async () => {
    await tasks.cancel();
    expect(cancelled).toEqual([]);
  });

  it('formats a finished duration for a card footnote', () => {
    expect(tasks.took(64_000)).toBe('took 1m 04s');
  });
});
