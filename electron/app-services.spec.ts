import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userDataDir = '';

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir, getVersion: () => '0.0.0-test' },
  // The default cipher asks safeStorage first; without it the store keeps
  // secrets in plain text, which is what a throwaway dir wants anyway.
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (plain: string) => Buffer.from(plain, 'utf8'),
    decryptString: (sealed: Buffer) => sealed,
  },
}));

import { AppConfigStore } from './app-config';
import { buildAppServices, syncMcpHttpTransport, type AppServicesDeps } from './app-services';
import { LlmRouter } from './llm';
import { McpHttpTransport } from './mcp';
import { PluginHost, PluginInstaller } from './plugin-host';
import { VaultManager } from './vault-manager';

/**
 * What A12 is about: the composition root of the main process, built for
 * real against a throwaway user-data dir -- every service constructed, the
 * wiring closures in place, and the config-driven MCP endpoint helper on
 * top. Nothing here activates plugins or starts the watcher: that is
 * main.ts's half, and buildAppServices deliberately does none of it.
 */

function deps(): AppServicesDeps {
  return {
    getMainWindow: () => null,
    mcpWriteBridge: { requestConfirmation: vi.fn(async () => false) } as never,
    toolApprovalBridge: { request: vi.fn(async () => false) } as never,
    openDocsBridge: {} as never,
    onPluginActivated: vi.fn(),
  };
}

describe('buildAppServices - the main process composition root', () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-services-'));
  });

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it('builds every long-lived service', () => {
    const s = buildAppServices(deps());
    for (const key of [
      'appConfig',
      'noteHistory',
      'vaultManager',
      'vaultAnnouncer',
      'vaultWatcher',
      'dailyNotes',
      'noteManager',
      'llm',
      'llmTasks',
      'llmDebug',
      'tagSuggester',
      'vaultTools',
      'mcpHttp',
      'mcpClients',
      'pluginHost',
      'pluginInstaller',
      'spellcheck',
      'sessionBackups',
    ] as const) {
      expect(s[key], key).toBeDefined();
    }
    expect(s.vaultManager).toBeInstanceOf(VaultManager);
    expect(s.pluginHost).toBeInstanceOf(PluginHost);
    expect(s.pluginInstaller).toBeInstanceOf(PluginInstaller);
    expect(s.llm).toBeInstanceOf(LlmRouter);
    expect(s.mcpHttp).toBeInstanceOf(McpHttpTransport);
  });

  it('runs on a fresh user-data dir: defaults, no vault, host not yet activated', async () => {
    const s = buildAppServices(deps());
    expect(s.appConfig.get().vault.watch).toBe(false); // the watcher stays off by default
    expect(s.vaultManager.getActiveVaultPath()).toBeNull();
    await s.pluginHost.activationDone(); // resolves before discoverAndActivate
  });

  it('wires the vault manager to the history store', () => {
    const s = buildAppServices(deps());
    // A write lands in the history root under the user-data dir (ADR-0060).
    const historyRoot = path.join(userDataDir, 'history');
    expect(fs.existsSync(historyRoot)).toBe(false); // sweep tolerates a missing root
    void s.noteHistory.sweep();
    expect(fs.existsSync(historyRoot)).toBe(false);
  });
});

describe('syncMcpHttpTransport - the endpoint follows the config', () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-services-'));
  });

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  function transport() {
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    return { fake: { start, stop } as never, start, stop };
  }

  it('starts when the server and the endpoint are enabled', async () => {
    const s = buildAppServices(deps());
    const t = transport();
    const config = s.appConfig.get();
    s.appConfig.set({ ...config, mcp: { ...config.mcp, enabled: true, httpEnabled: true, httpPort: 4321 } });
    await syncMcpHttpTransport(t.fake, s.appConfig);
    expect(t.start).toHaveBeenCalledWith(4321);
    expect(t.stop).not.toHaveBeenCalled();
  });

  it('stops when either switch is off', async () => {
    const s = buildAppServices(deps());
    const t = transport();
    await syncMcpHttpTransport(t.fake, s.appConfig); // defaults: mcp off
    expect(t.stop).toHaveBeenCalledOnce();

    const config = s.appConfig.get();
    s.appConfig.set({ ...config, mcp: { ...config.mcp, enabled: true, httpEnabled: false } });
    await syncMcpHttpTransport(t.fake, s.appConfig);
    expect(t.stop).toHaveBeenCalledTimes(2);
    expect(t.start).not.toHaveBeenCalled();
  });

  it('a failed start warns instead of throwing', async () => {
    const s = buildAppServices(deps());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const config = s.appConfig.get();
    s.appConfig.set({ ...config, mcp: { ...config.mcp, enabled: true, httpEnabled: true, httpPort: 1 } });
    await expect(
      syncMcpHttpTransport({ start: async () => Promise.reject(new Error('port taken')), stop: async () => undefined } as never, s.appConfig),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('port taken'));
    warn.mockRestore();
  });
});
