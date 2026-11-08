import { describe, expect, it } from 'vitest';
import { retireVerdict } from '../fleet/runner-lifecycle';
import { DEFAULT_SERVICE_IDLE_MS, ServiceIdleWatch, serviceIdleMsOf, serviceSleepVerdict, type ServiceLiveness } from './sleep';

/**
 * Drey Service's two-level sleep (req-164). Level one is the runner
 * component's — req-110's verdict, unchanged (`runner-lifecycle.spec`
 * holds it); level two is the service's own, here.
 */
const idle: ServiceLiveness = { dreyClients: 0, runnerAwake: false, gatewayServesDevices: false };

describe('the service sleep verdict', () => {
  it('nothing holding it: it may sleep', () => {
    expect(serviceSleepVerdict(idle)).toEqual({ sleep: true });
  });

  it('a Drey on the event stream holds it', () => {
    expect(serviceSleepVerdict({ ...idle, dreyClients: 1 })).toEqual({ sleep: false, reason: 'drey' });
  });

  it('an awake runner holds it — a live run or an On/Paused Autopilot keeps the runner awake', () => {
    expect(serviceSleepVerdict({ ...idle, runnerAwake: true })).toEqual({ sleep: false, reason: 'runner' });
  });

  it('an enabled remote gateway with a paired device holds it: a phone cannot wake a service that is gone', () => {
    expect(serviceSleepVerdict({ ...idle, gatewayServesDevices: true })).toEqual({ sleep: false, reason: 'remote gateway' });
  });

  it('names the first holder when several hold', () => {
    expect(serviceSleepVerdict({ dreyClients: 2, runnerAwake: true, gatewayServesDevices: true })).toEqual({ sleep: false, reason: 'drey' });
  });
});

describe('level one stays req-110: the runner component sleeps on the runner verdict', () => {
  it('a live run keeps the runner, so the runner holds the service', () => {
    expect(retireVerdict({ live: 1, keepsAlive: false })).toEqual({ exiting: false, reason: 'live runs' });
  });

  it('the Autopilot keeps the runner; Off with nothing live lets it sleep', () => {
    expect(retireVerdict({ live: 0, keepsAlive: true })).toEqual({ exiting: false, reason: 'autopilot' });
    expect(retireVerdict({ live: 0, keepsAlive: false })).toEqual({ exiting: true });
  });
});

describe('the service idle span', () => {
  it('counts from the moment the last holder let go, not from the last request', () => {
    let now = 0;
    const watch = new ServiceIdleWatch(1_000, () => now);
    now = 500;
    expect(watch.expired({ ...idle, dreyClients: 1 })).toBe(false);
    now = 5_000;
    // Drey closed at 5 s: the span starts now.
    expect(watch.expired(idle)).toBe(false);
    now = 5_900;
    expect(watch.expired(idle)).toBe(false);
    now = 6_000;
    expect(watch.expired(idle)).toBe(true);
  });

  it('a holder coming back resets the clock', () => {
    let now = 0;
    const watch = new ServiceIdleWatch(1_000, () => now);
    now = 900;
    expect(watch.expired(idle)).toBe(false);
    expect(watch.expired({ ...idle, runnerAwake: true })).toBe(false);
    now = 1_500;
    expect(watch.expired(idle)).toBe(false);
    now = 2_500;
    expect(watch.expired(idle)).toBe(true);
  });

  it('a paired device keeps it awake however long nothing else happens', () => {
    let now = 0;
    const watch = new ServiceIdleWatch(1_000, () => now);
    now = 10 * 60 * 60_000;
    expect(watch.expired({ ...idle, gatewayServesDevices: true })).toBe(false);
  });

  it('a fresh service with nobody coming counts from its start', () => {
    let now = 0;
    const watch = new ServiceIdleWatch(1_000, () => now);
    now = 1_000;
    expect(watch.expired(idle)).toBe(true);
  });

  it('the span setting: minutes, 15 by default', () => {
    expect(serviceIdleMsOf(30)).toBe(30 * 60_000);
    expect(serviceIdleMsOf(undefined)).toBe(DEFAULT_SERVICE_IDLE_MS);
    expect(serviceIdleMsOf(0)).toBe(DEFAULT_SERVICE_IDLE_MS);
    expect(serviceIdleMsOf('10')).toBe(DEFAULT_SERVICE_IDLE_MS);
  });
});
