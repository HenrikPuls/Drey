import { describe, expect, it, vi } from 'vitest';
import { DeviceRegistry, FailureLimiter, PairingCodes } from './auth';
import { route, type RemoteRequest, type RouterDeps } from './router';
import { RemoteService } from './service';
import type { TicketsRemotePort } from '../contracts/remote-protocol';
import {
  DEFAULT_VIDEO_MAX_MB,
  chatSettingsOf,
  normalizeVideoSettings,
  parseRevoke,
  parseSettingsPatch,
  type SettingsAccess,
} from './settings';

const HOST = 'desk.test';

const req = (patch: Partial<RemoteRequest>): RemoteRequest => ({
  method: 'GET',
  path: '/api/settings',
  host: HOST,
  origin: undefined,
  authorization: undefined,
  body: undefined,
  remote: '127.0.0.1',
  ...patch,
});

describe('settings parsers', () => {
  it('folds stored video settings into valid ones', () => {
    expect(DEFAULT_VIDEO_MAX_MB).toBe(25);
    expect(normalizeVideoSettings({}, 0)).toEqual({ inGit: false, maxMb: 25, existing: 0 });
    expect(normalizeVideoSettings({ inGit: true, maxMb: 50 }, 3)).toEqual({ inGit: true, maxMb: 50, existing: 3 });
    expect(normalizeVideoSettings({ inGit: 'yes', maxMb: 0 }, 0)).toEqual({ inGit: false, maxMb: 25, existing: 0 });
    // The bounds are 1 and 200 MB; the retired limitMb is not read at all.
    expect(normalizeVideoSettings({ maxMb: 1 }, 0).maxMb).toBe(1);
    expect(normalizeVideoSettings({ maxMb: 200 }, 0).maxMb).toBe(200);
    expect(normalizeVideoSettings({ maxMb: 201 }, 0).maxMb).toBe(25);
    expect(normalizeVideoSettings({ limitMb: 500 } as never, 0).maxMb).toBe(25);
  });

  it('reads a patch strictly', () => {
    expect(parseSettingsPatch({ maxMb: 40 })).toEqual({ ok: true, value: { inGit: undefined, maxMb: 40, confirm: undefined } });
    expect(parseSettingsPatch({ inGit: true, confirm: true }).ok).toBe(true);
    expect(parseSettingsPatch({}).ok).toBe(false);
    expect(parseSettingsPatch({ maxMb: 1.5 }).ok).toBe(false);
    expect(parseSettingsPatch({ maxMb: 0 }).ok).toBe(false);
    expect(parseSettingsPatch({ maxMb: 201 }).ok).toBe(false);
    expect(parseSettingsPatch({ maxMb: 1 }).ok).toBe(true);
    expect(parseSettingsPatch({ maxMb: 200 }).ok).toBe(true);
    expect(parseSettingsPatch({ limitMb: 800 }).ok).toBe(false);
    expect(parseSettingsPatch({ inGit: 'on' }).ok).toBe(false);
    expect(parseSettingsPatch('x').ok).toBe(false);
  });

  it('reads a revoke by device id only', () => {
    expect(parseRevoke({ id: 'abc123' })).toEqual({ ok: true, value: { id: 'abc123' } });
    expect(parseRevoke({ id: '../x' }).ok).toBe(false);
    expect(parseRevoke(null).ok).toBe(false);
  });
});

describe('the settings routes', () => {
  async function setup(settings?: SettingsAccess): Promise<{ deps: RouterDeps; auth: string; read: string }> {
    const devices = new DeviceRegistry([], async () => undefined);
    const { token } = await devices.add('iPad', false, new Date());
    const { token: viewer } = await devices.add('Viewer', true, new Date());
    return {
      deps: {
        port: {} as unknown as TicketsRemotePort,
        devices,
        pairing: new PairingCodes(),
        limiter: new FailureLimiter(3, 60_000),
        allowedHosts: () => new Set([HOST]),
        now: () => new Date('2026-11-03T10:00:00Z'),
        log: () => undefined,
        onPaired: () => undefined,
        settings,
      },
      auth: `Bearer ${token}`,
      read: `Bearer ${viewer}`,
    };
  }

  it('answers 404 on a host without a settings half', async () => {
    const { deps, auth } = await setup();
    expect((await route(req({ authorization: auth }), deps)).status).toBe(404);
  });

  it('reads, patches and revokes through the access, naming the asking device', async () => {
    const access: SettingsAccess = {
      read: vi.fn(async () => ({
        ok: true as const,
        devices: [],
        engine: {
          videos: { inGit: false, maxMb: 25, existing: 0 },
          chat: { provider: 'lmstudio', providerLabel: 'LM Studio', baseUrl: null, model: null, hasKey: false, problem: 'no endpoint' },
        },
      })),
      testChat: vi.fn(async () => ({ ok: true, message: 'Connected.' })),
      patch: vi.fn(async () => ({ ok: false as const, error: 'nope' })),
      revoke: vi.fn(async () => ({ ok: false as const, error: 'nope' })),
    };
    const { deps, auth, read } = await setup(access);
    const got = await route(req({ authorization: auth }), deps);
    expect(got.status).toBe(200);
    expect(access.read).toHaveBeenCalledTimes(1);

    const patched = await route(req({ method: 'POST', path: '/api/settings/engine', authorization: auth, body: { maxMb: 90 } }), deps);
    expect(patched.status).toBe(200);
    expect(access.patch).toHaveBeenCalledWith({ inGit: undefined, maxMb: 90, confirm: undefined }, expect.any(String));

    await route(req({ method: 'POST', path: '/api/settings/devices/revoke', authorization: auth, body: { id: 'abc' } }), deps);
    expect(access.revoke).toHaveBeenCalledWith('abc', expect.any(String));

    const tested = await route(req({ method: 'POST', path: '/api/settings/chat/test', authorization: auth, body: {} }), deps);
    expect(tested).toMatchObject({ status: 200, body: { ok: true, message: 'Connected.' } });
    expect(access.testChat).toHaveBeenCalledTimes(1);

    const bad = await route(req({ method: 'POST', path: '/api/settings/engine', authorization: auth, body: { maxMb: 0 } }), deps);
    expect(bad.body).toMatchObject({ ok: false });

    const viewer = await route(req({ method: 'POST', path: '/api/settings/engine', authorization: read, body: { maxMb: 90 } }), deps);
    expect(viewer.status).toBe(403);
  });
});

describe('the chat settings (D-1, E12-3b)', () => {
  const memory = (values: Record<string, unknown>): { get<T>(key: string): Promise<T | undefined> } => ({
    get: async <T>(key: string) => values[key] as T | undefined,
  });

  it('shows what Drey pushed, never the key, and the reason a turn could not run', async () => {
    const view = await chatSettingsOf(
      memory({ 'chat.provider': 'zai-glm', 'chat.baseUrl': 'https://api.z.ai/api/anthropic', 'chat.model': 'glm-5.3-flash', 'chat.apiKey': 'secret' }),
    );
    expect(view).toEqual({
      provider: 'zai-glm',
      providerLabel: 'Z.ai GLM',
      baseUrl: 'https://api.z.ai/api/anthropic',
      model: 'glm-5.3-flash',
      hasKey: true,
      problem: null,
    });
    expect(JSON.stringify(view)).not.toContain('secret');

    const stuck = await chatSettingsOf(memory({ 'chat.provider': 'copilot-cli', 'chat.model': 'gpt' }));
    expect(stuck.problem).toMatch(/GitHub Copilot CLI.*cannot talk to this provider/);
    expect(stuck.hasKey).toBe(false);
  });
});

describe('the remote service settings half', () => {
  it('keeps the video keys, demands the confirmation, and protects the asking device', async () => {
    const store = new Map<string, unknown>();
    const service = new RemoteService({
      config: {
        get: async <T>(key: string) => store.get(key) as T | undefined,
        set: async <T>(key: string, value: T) => void store.set(key, value),
      },
      port: {} as unknown as TicketsRemotePort,
      clientDir: '',
      log: () => undefined,
      onChanged: () => undefined,
      countVideos: async () => 4,
    });
    await service.init();
    const devices = service as unknown as { registry(): DeviceRegistry };
    const phone = await devices.registry().add('Phone', false, new Date());
    const tablet = await devices.registry().add('Tablet', false, new Date());
    const access = service.settings();

    const first = await access.read(phone.device.id);
    expect(first).toMatchObject({ ok: true, engine: { videos: { inGit: false, maxMb: 25, existing: 4 } } });
    expect(first.devices.map((d) => [d.name, d.current])).toEqual([['Phone', true], ['Tablet', false]]);

    expect(await access.patch({ inGit: true }, phone.device.id)).toMatchObject({ ok: false });
    expect(store.has('videos.inGit')).toBe(false);
    expect(await access.patch({ inGit: true, confirm: true, maxMb: 60 }, phone.device.id)).toMatchObject({
      ok: true,
      engine: { videos: { inGit: true, maxMb: 60 } },
    });
    expect(await access.patch({ inGit: false }, phone.device.id)).toMatchObject({ engine: { videos: { inGit: false } } });

    expect(await access.revoke(phone.device.id, phone.device.id)).toMatchObject({ ok: false });
    const after = await access.revoke(tablet.device.id, phone.device.id);
    expect(after).toMatchObject({ ok: true });
    expect('devices' in after && after.devices.map((d) => d.name)).toEqual(['Phone']);
    expect(await access.revoke('nope', phone.device.id)).toMatchObject({ ok: false });
  });
});
