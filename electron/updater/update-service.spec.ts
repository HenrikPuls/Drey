import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The update flow's state machine (milestone 82, ADR-0074) over a fake
 * electron-updater, fake dialogs and a fake window: the asks, the skip
 * rule, the download phases, and the install that only runs its
 * installer once the window has really closed — a cancelled exit prompt
 * leaves the app running with the plain quit semantics untouched.
 */

const mocks = vi.hoisted(() => {
  const shown: Array<{ message: string; detail: string; buttons: string[] }> = [];
  return {
    version: '0.6.0',
    shown,
    /** Queued `dialog.showMessageBox` responses (button indexes); 0 when empty. */
    responses: [] as number[],
    quit: vi.fn(),
    openExternal: vi.fn(),
    showMessageBox: vi.fn((first: unknown, second?: unknown) => {
      // Called as (owner, options) with a live window, as (options) without.
      const options = (second ?? first) as { message: string; detail: string; buttons: string[] };
      shown.push({ message: options.message, detail: options.detail, buttons: options.buttons });
      const response = mocks.responses.length > 0 ? (mocks.responses.shift() as number) : 0;
      return Promise.resolve({ response, checkboxChecked: false });
    }),
  };
});

vi.mock('electron', () => ({
  app: { getVersion: () => mocks.version, quit: mocks.quit },
  dialog: { showMessageBox: mocks.showMessageBox },
  shell: { openExternal: mocks.openExternal },
}));

vi.mock('electron-updater', () => ({ NsisUpdater: class {} }));

import type { BrowserWindow } from 'electron';
import { DEFAULT_APP_CONFIG, type AppConfig, type UpdatesConfig } from '../../shared/app-config';
import type { AppConfigStore } from '../app-config';
import { UpdateService, type UpdaterHandle } from './update-service';

/** An `AppConfigStore` stand-in: just `get()` and the main-side `patch()`. */
function fakeConfigStore(updates: Partial<UpdatesConfig> = {}): AppConfigStore {
  const config: AppConfig = {
    ...DEFAULT_APP_CONFIG,
    updates: { ...DEFAULT_APP_CONFIG.updates, ...updates },
  };
  const store = {
    get: (): AppConfig => config,
    patch: (patch: Partial<AppConfig>): AppConfig => Object.assign(config, patch),
  };
  return store as unknown as AppConfigStore;
}

class FakeUpdater {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = false;
  logger = null;
  checkForUpdates = vi.fn();
  downloadUpdate = vi.fn();
  quitAndInstall = vi.fn();
  private readonly listeners = new Map<string, Array<(arg?: unknown) => void>>();

  on(event: string, listener: (arg?: unknown) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, arg?: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener(arg);
    }
  }
}

/** Fake main window: `close()` records; the test decides whether it closes. */
class FakeWindow {
  private closedHandlers: Array<() => void> = [];
  closeCalls = 0;
  cancelledClose = false;
  closed = false;

  once(event: 'closed', listener: () => void): this {
    if (event === 'closed') {
      this.closedHandlers.push(listener);
    }
    return this;
  }

  isDestroyed = (): boolean => this.closed;

  close = (): void => {
    this.closeCalls += 1;
    if (!this.cancelledClose) {
      this.finishClose();
    }
  };

  /** The prompt answered "save"/"discard" — the window really closes. */
  finishClose(): void {
    this.closed = true;
    for (const handler of [...this.closedHandlers]) {
      handler();
    }
  }
}

function makeService(updates: Partial<UpdatesConfig> = {}): {
  service: UpdateService;
  updater: FakeUpdater;
  window: FakeWindow;
} {
  const updater = new FakeUpdater();
  const window = new FakeWindow();
  const service = new UpdateService({
    getMainWindow: () =>
      window.closed ? null : (window as unknown as BrowserWindow),
    appConfig: fakeConfigStore(updates),
    createUpdater: () => updater as unknown as UpdaterHandle,
  });
  return { service, updater, window };
}

function checkResult(version: string): { updateInfo: { version: string } } {
  return { updateInfo: { version } };
}

beforeEach(() => {
  mocks.shown.length = 0;
  mocks.responses.length = 0;
  mocks.quit.mockClear();
  mocks.openExternal.mockClear();
  mocks.showMessageBox.mockClear();
  mocks.version = '0.6.0';
});

describe('UpdateService', () => {
  it('is inert and reports unsupported when no updater can be built', async () => {
    const service = new UpdateService({
      getMainWindow: () => null,
      appConfig: fakeConfigStore(),
      createUpdater: () => null,
    });
    expect(service.status().phase).toBe('unsupported');

    await service.checkManually();
    expect(mocks.shown.map((d) => d.message)).toEqual(['This installation cannot update itself']);
    await service.runStartupCheck();
    expect(mocks.shown).toHaveLength(1); // the startup check stays silent
  });

  it('configures electron-updater so nothing happens unasked', () => {
    const { updater } = makeService();
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.allowPrerelease).toBe(false);
  });

  it('does not check on startup when the config switched the check off', async () => {
    const { service, updater } = makeService({ checkOnStartup: false });
    await service.runStartupCheck();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('stays silent on startup for the skipped version, records it in the status', async () => {
    const { service, updater } = makeService({ skippedVersion: '0.7.0' });
    updater.checkForUpdates.mockResolvedValue(checkResult('0.7.0'));
    await service.runStartupCheck();
    expect(mocks.shown).toHaveLength(0);
    expect(service.status().phase).toBe('available');
    expect(service.status().availableVersion).toBe('0.7.0');
  });

  it('runs the ask chain: available → download → downloaded → install on closed', async () => {
    const { service, updater, window } = makeService();
    updater.checkForUpdates.mockResolvedValue(checkResult('0.7.0'));
    updater.downloadUpdate.mockResolvedValue('C:\\cache\\drey-0.7.0-setup.exe');

    // The ask-before-download: "Download update" is button 0.
    const checking = service.checkManually();
    await vi.waitFor(() => expect(mocks.shown).toHaveLength(1));
    expect(mocks.shown[0]).toMatchObject({
      message: 'A Drey update is available',
      buttons: ['Download update', 'Skip this version', 'Remind me later'],
    });
    await checking;
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);

    updater.emit('download-progress', { percent: 42.3 });
    expect(service.status().phase).toBe('downloading');
    expect(service.status().progressPercent).toBe(42);

    updater.emit('update-downloaded', { version: '0.7.0' });
    await vi.waitFor(() => expect(mocks.shown).toHaveLength(2));
    expect(mocks.shown[1]).toMatchObject({
      message: 'Update downloaded',
      buttons: ['Install and restart', 'Later'],
    });
    await vi.waitFor(() => expect(window.closeCalls).toBe(1));
    window.finishClose(); // the exit prompt answered "save"
    expect(service.status().phase).toBe('downloaded');

    service.finishQuit();
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    // One-shot: electron-updater's own quit must not re-enter it.
    service.finishQuit();
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('persists the skipped version on "Skip this version"', async () => {
    const store = fakeConfigStore();
    const updater = new FakeUpdater();
    const service = new UpdateService({
      getMainWindow: () => null,
      appConfig: store,
      createUpdater: () => updater as unknown as UpdaterHandle,
    });
    updater.checkForUpdates.mockResolvedValue(checkResult('0.7.0'));
    mocks.responses.push(1); // "Skip this version"

    await service.checkManually();
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(store.get().updates.skippedVersion).toBe('0.7.0');
  });

  it('stops at the found version on "Remind me later"', async () => {
    const { service, updater } = makeService();
    updater.checkForUpdates.mockResolvedValue(checkResult('0.7.0'));
    mocks.responses.push(2);

    await service.checkManually();
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(service.status().phase).toBe('available');
  });

  it('reports "up to date" on a manual check with no newer release', async () => {
    const { service, updater } = makeService();
    updater.checkForUpdates.mockResolvedValue(checkResult('0.6.0'));

    await service.checkManually();
    expect(mocks.shown.map((d) => d.message)).toEqual(['Drey is up to date']);
    expect(service.status().phase).toBe('up-to-date');
  });

  it('shows the failure on a manual check, stays silent on the startup check', async () => {
    const { service, updater } = makeService();
    updater.checkForUpdates.mockRejectedValue(new Error('getaddrinfo ENOTFOUND github.com'));

    await service.checkManually();
    expect(mocks.shown.map((d) => d.message)).toEqual(['The update check failed']);
    expect(service.status().phase).toBe('error');
    expect(service.status().error).toContain('ENOTFOUND');

    mocks.shown.length = 0;
    updater.checkForUpdates.mockRejectedValue(new Error('again'));
    await service.runStartupCheck();
    expect(mocks.shown).toHaveLength(0);
    expect(service.status().phase).toBe('error');
  });

  it('ignores a release whose version is not a newer x.y.z', async () => {
    const { service, updater } = makeService();
    updater.checkForUpdates.mockResolvedValue(checkResult('nonsense-tag'));

    await service.checkManually();
    expect(service.status().phase).toBe('up-to-date');
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it('does not run the installer when the exit prompt is cancelled', async () => {
    const { service, updater, window } = makeService();
    updater.checkForUpdates.mockResolvedValue(checkResult('0.7.0'));
    updater.downloadUpdate.mockResolvedValue('C:\\cache\\drey-0.7.0-setup.exe');
    window.cancelledClose = true;

    await service.checkManually(); // ask 1 answered "Download update"
    updater.emit('update-downloaded', { version: '0.7.0' });
    await vi.waitFor(() => expect(window.closeCalls).toBe(1)); // ask 2 → install
    // The user cancelled the exit prompt: the window never closed, so
    // nothing installs — however the app might quit later on its own.
    service.finishQuit();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();

    // The eventual close (the next quit) is when the asked-for install runs.
    window.finishClose();
    service.finishQuit();
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('pushes every phase change to the status listeners', async () => {
    const { service, updater } = makeService();
    const seen: string[] = [];
    service.onStatus((status) => seen.push(status.phase));

    updater.checkForUpdates.mockResolvedValue(checkResult('0.7.0'));
    mocks.responses.push(2); // "Remind me later" — the flow stops at `available`
    await service.checkManually();

    expect(seen).toEqual(['checking', 'available']);
  });
});
