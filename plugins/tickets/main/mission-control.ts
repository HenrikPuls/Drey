/**
 * The Mission Control host (ADR-0088 E5c, concept §3.5.4): the same web
 * app the engine serves, in a Drey window. The Work panel's ⋯ row asks
 * over the plugin IPC; main takes a local client from the engine
 * (`RemoteService.localClient` — registered directly as a device, no
 * pairing dance) and opens the gateway URL with `#token=` appended.
 * While the remote is off the URL is null and the answer says so
 * honestly ('Enable remote access in Settings → Tickets → Remote').
 *
 * The window mirrors the browser plugin's view discipline
 * (view-manager.ts, minimised): its own persisted partition, no
 * preload, sandbox + context isolation, http(s)/about top-level
 * navigation only, off-window links to the OS browser, no powerful
 * permissions. The engine's gateway serves the app and its own CSP —
 * nothing is relaxed here.
 */
import { BrowserWindow, session, shell } from 'electron';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What `RemoteService.localClient` returns (the engine's wire shape). */
export interface LocalClientReply {
  ok: boolean;
  token?: string;
  url?: string | null;
  error?: string;
}

/**
 * The window surface the host drives — the whole Electron seam behind
 * one interface, so the spec runs without a display: the production
 * factory builds a `BrowserWindow`, the spec a fake.
 */
export interface MissionControlView {
  loadURL(url: string): Promise<void>;
  show(): void;
  focus(): void;
  isDestroyed(): boolean;
  destroy(): void;
  onClosed(handler: () => void): void;
}

export interface MissionControlDeps {
  /** Asks the engine for a local client (`RemoteService.localClient`). */
  readonly localClient: () => Promise<LocalClientReply>;
  /** Builds the window; null when it cannot be created. */
  readonly createView: () => MissionControlView | null;
}

/** The honest answer while the remote gateway is off (`localClient` returns no URL). */
export const MISSION_CONTROL_REMOTE_OFF = 'Enable remote access in Settings → Tickets → Remote.';

/**
 * Owns the one Mission Control window per Drey run: asks the engine for
 * a local client, builds the window, loads `${url}#token=${token}`.
 * A second `open` while the window lives only focuses it — no second
 * device registration. Never throws; failures come back as `{ok: false,
 * error}` for the row to surface in the board's message bar.
 */
export class MissionControlHost {
  private view: MissionControlView | null = null;

  constructor(private readonly deps: MissionControlDeps) {}

  /** Opens (or focuses) the Mission Control window. */
  async open(): Promise<{ ok: boolean; error?: string }> {
    const existing = this.view;
    if (existing !== null && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return { ok: true };
    }
    let reply: LocalClientReply;
    try {
      reply = await this.deps.localClient();
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
    if (reply.ok !== true) {
      return { ok: false, error: reply.error ?? 'the engine did not register the window' };
    }
    if (typeof reply.url !== 'string' || reply.url === '') {
      return { ok: false, error: MISSION_CONTROL_REMOTE_OFF };
    }
    const token = typeof reply.token === 'string' ? reply.token : '';
    if (token === '') {
      return { ok: false, error: 'the engine did not return a token' };
    }
    const view = this.deps.createView();
    if (view === null) {
      return { ok: false, error: 'the window could not be created' };
    }
    this.view = view;
    view.onClosed(() => {
      if (this.view === view) {
        this.view = null;
      }
    });
    try {
      await view.loadURL(`${reply.url}#token=${encodeURIComponent(token)}`);
    } catch (error) {
      view.destroy();
      if (this.view === view) {
        this.view = null;
      }
      return { ok: false, error: `Mission Control did not load — ${messageOf(error)}` };
    }
    view.show();
    view.focus();
    return { ok: true };
  }

  /** Closes the window (plugin deactivation). */
  dispose(): void {
    this.view?.destroy();
    this.view = null;
  }
}

// --- the Electron-backed view -------------------------------------------

/** Cookies + storage for the Mission Control window — isolated from the
 *  app's own session and from the browser plugin's tabs. */
const PARTITION = 'persist:mission-control';

let partitionPrepared = false;

function preparePartition(): void {
  if (partitionPrepared) {
    return;
  }
  partitionPrepared = true;
  const ses = session.fromPartition(PARTITION);
  // Deny every powerful permission by default (geolocation, notifications,
  // camera/mic, …) — the same rule the browser plugin's partition sets.
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

/**
 * Builds the real window: hidden until the app has loaded (no white
 * flash), no preload (the engine's web app gets no bridge), sandboxed.
 * The app is an SPA at the gateway origin — top-level navigation stays
 * http(s)/about, off-window http(s) and mailto links go to the OS
 * browser, everything else is denied (view-manager's rule, tightened
 * nowhere).
 */
export function createMissionControlView(log: (line: string) => void): MissionControlView | null {
  preparePartition();
  let win: BrowserWindow;
  try {
    win = new BrowserWindow({
      width: 1280,
      height: 840,
      minWidth: 1000,
      minHeight: 640,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#18191b',
      title: 'Mission Control',
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        // No preload: this is the engine's own web app, it gets no bridge.
      },
    });
  } catch (error) {
    log(`mission-control: the window could not be created — ${messageOf(error)}`);
    return null;
  }

  const wc = win.webContents;
  wc.setUserAgent(
    wc
      .getUserAgent()
      .replace(/\s?(Electron|Drey)\/[^\s]+/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim(),
  );
  wc.on('will-navigate', (event, url) => {
    if (!/^(https?:|about:)/i.test(url)) {
      event.preventDefault();
    }
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  wc.on('render-process-gone', (_event, details) =>
    log(`mission-control: the render process is gone — ${details.reason}`),
  );

  return {
    loadURL: (url) => win.loadURL(url),
    show: () => win.show(),
    focus: () => win.focus(),
    isDestroyed: () => win.isDestroyed(),
    destroy: () => {
      if (!win.isDestroyed()) {
        win.destroy();
      }
    },
    onClosed: (handler) => win.on('closed', handler),
  };
}
