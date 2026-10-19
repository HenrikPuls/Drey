import type { NotifyRequest } from '../../../shared/plugin-api/renderer';

/** The slice of the Web Notification API `ui.notify` needs (a seam for the spec). */
export interface NotificationApi {
  readonly permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  new (title: string, options?: NotificationOptions): { onclick: ((this: unknown, ev: Event) => unknown) | null };
}

/** The page's own Notification API, or undefined where there is none. */
export function browserNotificationApi(): NotificationApi | undefined {
  return typeof Notification === 'undefined' ? undefined : (Notification as unknown as NotificationApi);
}

/**
 * `ui.notify` (SDK 1.32, req-57): an operating-system notification through
 * the renderer's Web Notification API, which Electron turns into a Windows
 * toast. A click brings the window to the front, then runs the plugin's
 * callback. False when the system shows none (permission denied, no API).
 */
export async function showOsNotification(
  request: NotifyRequest,
  focusWindow: () => Promise<void>,
  api: NotificationApi | undefined,
): Promise<boolean> {
  if (api === undefined) {
    return false;
  }
  let permission = api.permission;
  if (permission === 'default') {
    permission = await api.requestPermission().catch(() => 'denied' as const);
  }
  if (permission !== 'granted') {
    return false;
  }
  const shown = new api(request.title, {
    ...(request.body !== undefined ? { body: request.body } : {}),
    ...(request.tag !== undefined ? { tag: request.tag } : {}),
  });
  shown.onclick = (): void => {
    void focusWindow()
      .catch(() => undefined)
      .then(() => request.onClick?.());
  };
  return true;
}
