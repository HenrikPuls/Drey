import { TestBed } from '@angular/core/testing';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { DreyApi, UpdateStatus } from '../../../shared/ipc-api';
import { UpdateService } from './update.service';

/**
 * The renderer half of the update system (ADR-0074): the status mirror
 * and — since req-45 — the transient green note for a manual check's
 * positive answer, which replaced the "Drey is up to date" dialog.
 */

function status(phase: UpdateStatus['phase']): UpdateStatus {
  return {
    phase,
    currentVersion: '0.7.1',
    availableVersion: null,
    progressPercent: null,
    error: null,
  };
}

describe('UpdateService (renderer)', () => {
  let checkForUpdates: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    checkForUpdates = vi.fn();
    window.dreyApi = {
      getUpdateStatus: () => Promise.resolve(status('idle')),
      onUpdateStatusChanged: () => () => undefined,
      checkForUpdates,
    } as unknown as DreyApi;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  it('turns a manual check\'s "up to date" into the transient note', async () => {
    checkForUpdates.mockResolvedValue(status('up-to-date'));
    const service = TestBed.inject(UpdateService);

    service.checkNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.notice()).toBe('The latest version (Drey 0.7.1) is already installed.');

    // The note clears itself after a few seconds.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(service.notice()).toBeNull();
  });

  it('shows no note for a check that found something (main asks, not text)', async () => {
    checkForUpdates.mockResolvedValue({ ...status('available'), availableVersion: '0.8.0' });
    const service = TestBed.inject(UpdateService);

    service.checkNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.notice()).toBeNull();
  });

  it('keeps a failed manual check silent too (main shows the error dialog)', async () => {
    checkForUpdates.mockResolvedValue({ ...status('error'), error: 'offline' });
    const service = TestBed.inject(UpdateService);

    service.checkNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.notice()).toBeNull();
  });
});
