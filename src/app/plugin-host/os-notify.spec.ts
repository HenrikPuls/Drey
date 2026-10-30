import { describe, expect, it, vi } from 'vitest';
import { showOsNotification, type NotificationApi } from './os-notify';

/** A scripted Notification constructor: records what was shown, lets the spec click it. */
function fakeApi(permission: NotificationPermission, afterRequest: NotificationPermission = permission) {
  const shown: Array<{ title: string; options?: NotificationOptions; click: () => void }> = [];
  class FakeNotification {
    static permission = permission;
    static requestPermission = vi.fn(async () => afterRequest);
    onclick: ((this: unknown, ev: Event) => unknown) | null = null;
    constructor(title: string, options?: NotificationOptions) {
      shown.push({ title, options, click: () => this.onclick?.call(this, new Event('click')) });
    }
  }
  return { api: FakeNotification as unknown as NotificationApi, shown, requestPermission: FakeNotification.requestPermission };
}

describe('showOsNotification (ui.notify, req-64)', () => {
  it('shows title, body and tag; a click focuses the window, then runs the callback', async () => {
    const { api, shown } = fakeApi('granted');
    const order: string[] = [];
    const focus = vi.fn(async () => {
      order.push('focus');
    });
    const ok = await showOsNotification(
      { title: 'T-0042 waits for you', body: 'Which API?', tag: 'run-1', onClick: () => order.push('click') },
      focus,
      api,
    );
    expect(ok).toBe(true);
    expect(shown[0]).toMatchObject({ title: 'T-0042 waits for you', options: { body: 'Which API?', tag: 'run-1' } });
    shown[0]!.click();
    await vi.waitFor(() => expect(order).toEqual(['focus', 'click']));
  });

  it('asks once when undecided and shows nothing when refused or unavailable', async () => {
    const granted = fakeApi('default', 'granted');
    expect(await showOsNotification({ title: 'a' }, async () => undefined, granted.api)).toBe(true);
    expect(granted.requestPermission).toHaveBeenCalledTimes(1);

    const denied = fakeApi('denied');
    expect(await showOsNotification({ title: 'a' }, async () => undefined, denied.api)).toBe(false);
    expect(denied.shown).toEqual([]);

    expect(await showOsNotification({ title: 'a' }, async () => undefined, undefined)).toBe(false);
  });
});
