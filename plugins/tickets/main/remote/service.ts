/**
 * The tickets remote as the plugin runs it (req-66, ADR-0084): reads
 * the `remote.*` config, keeps the paired devices and the waiting
 * pairing, and (re)starts the gateway whenever Settings changes it —
 * the remote's settings apply at once, unlike the fleet's.
 */
import { networkInterfaces } from 'node:os';
import type { TicketsRemotePort } from '../../shared/remote-protocol';
import { DeviceRegistry, FailureLimiter, PairingCodes, type DeviceView, type RemoteDevice } from './auth';
import {
  allowedHostsOf,
  bindAddressOf,
  deviceUrlOf,
  normalizeRemoteConfig,
  pairingUrlOf,
  REMOTE_CONFIG_KEYS,
  type RemoteConfig,
} from './config';
import { RemoteGateway } from './gateway';
import { qrMatrix } from './qr';

export interface NetworkAddress {
  readonly name: string;
  readonly address: string;
}

export interface PairingView {
  readonly code: string;
  readonly url: string;
  readonly deviceName: string;
  readonly readOnly: boolean;
  readonly expiresAt: string;
  /** The QR code of `url`, one string of `0`/`1` per row. */
  readonly qr: readonly string[];
}

export interface RemoteStatus {
  readonly config: RemoteConfig;
  /** `host:port` while the gateway listens. */
  readonly listening: string | null;
  /** Why it does not, when it should. */
  readonly error: string | null;
  /** The address a device opens; null while off. */
  readonly deviceUrl: string | null;
  /** The device URL is this computer's loopback — no phone reaches it without a public URL. */
  readonly needsPublicUrl: boolean;
  readonly devices: readonly DeviceView[];
  readonly pairing: PairingView | null;
  readonly interfaces: readonly NetworkAddress[];
}

export interface RemotePatch {
  readonly enabled?: boolean;
  readonly mode?: string;
  readonly lanAddress?: string | null;
  readonly port?: number;
  readonly publicUrl?: string | null;
  readonly allowBypass?: boolean;
}

export interface RemoteServiceDeps {
  readonly config: {
    get<T>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T): Promise<void>;
  };
  readonly port: TicketsRemotePort;
  readonly clientDir: string;
  readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void;
  /** Settings shows a fresh status (a device paired, the server stopped). */
  readonly onChanged: () => void;
  readonly interfaces?: () => readonly NetworkAddress[];
  readonly now?: () => Date;
}

export class RemoteService {
  private config: RemoteConfig = normalizeRemoteConfig({});
  private devices: DeviceRegistry | null = null;
  private readonly pairing = new PairingCodes();
  private readonly limiter = new FailureLimiter();
  private readonly gateway: RemoteGateway;
  private bindHost = '127.0.0.1';
  private allowedHosts: ReadonlySet<string> = new Set();
  private error: string | null = null;
  private readonly now: () => Date;

  constructor(private readonly deps: RemoteServiceDeps) {
    this.now = deps.now ?? ((): Date => new Date());
    this.gateway = new RemoteGateway({
      clientDir: deps.clientDir,
      log: deps.log,
      router: {
        port: deps.port,
        // The registry exists once init() ran; the gateway only listens after that.
        devices: {
          byToken: (token) => this.registry().byToken(token),
          touch: (id, at) => this.registry().touch(id, at),
          add: (name, readOnly, at) => this.registry().add(name, readOnly, at),
        },
        pairing: this.pairing,
        limiter: this.limiter,
        allowedHosts: () => this.allowedHosts,
        now: this.now,
        log: (message) => deps.log(message),
        onPaired: () => deps.onChanged(),
      },
    });
  }

  /** Whether a device may start bypass runs — the port asks per run. */
  allowBypass(): boolean {
    return this.config.allowBypass;
  }

  async init(): Promise<void> {
    const get = this.deps.config.get.bind(this.deps.config);
    this.config = normalizeRemoteConfig({
      enabled: await get(REMOTE_CONFIG_KEYS.enabled),
      mode: await get(REMOTE_CONFIG_KEYS.mode),
      lanAddress: await get(REMOTE_CONFIG_KEYS.lanAddress),
      port: await get(REMOTE_CONFIG_KEYS.port),
      publicUrl: await get(REMOTE_CONFIG_KEYS.publicUrl),
      allowBypass: await get(REMOTE_CONFIG_KEYS.allowBypass),
    });
    const stored = await get<unknown>(REMOTE_CONFIG_KEYS.devices);
    this.devices = new DeviceRegistry(Array.isArray(stored) ? (stored as RemoteDevice[]) : [], (list) =>
      this.deps.config.set(REMOTE_CONFIG_KEYS.devices, list),
    );
    await this.apply();
  }

  status(): RemoteStatus {
    const pending = this.pairing.current(this.now().getTime());
    const deviceUrl = this.config.enabled ? deviceUrlOf(this.config, this.bindHost) : null;
    let pairing: PairingView | null = null;
    if (pending !== null && deviceUrl !== null) {
      const url = pairingUrlOf(deviceUrl, pending.code);
      pairing = {
        code: pending.code,
        url,
        deviceName: pending.deviceName,
        readOnly: pending.readOnly,
        expiresAt: new Date(pending.expiresAt).toISOString(),
        qr: qrMatrix(url).map((row) => row.map((dark) => (dark ? '1' : '0')).join('')),
      };
    }
    return {
      config: this.config,
      listening: this.gateway.listening,
      error: this.error,
      deviceUrl,
      needsPublicUrl: this.config.enabled && this.config.mode === 'loopback' && this.config.publicUrl === null,
      devices: this.registry().list(),
      pairing,
      interfaces: this.listInterfaces(),
    };
  }

  async configure(patch: RemotePatch): Promise<RemoteStatus> {
    const next = normalizeRemoteConfig({ ...this.config, ...patch });
    const set = this.deps.config.set.bind(this.deps.config);
    await set(REMOTE_CONFIG_KEYS.enabled, next.enabled);
    await set(REMOTE_CONFIG_KEYS.mode, next.mode);
    await set(REMOTE_CONFIG_KEYS.lanAddress, next.lanAddress ?? '');
    await set(REMOTE_CONFIG_KEYS.port, next.port);
    await set(REMOTE_CONFIG_KEYS.publicUrl, next.publicUrl ?? '');
    await set(REMOTE_CONFIG_KEYS.allowBypass, next.allowBypass);
    const restart =
      next.enabled !== this.config.enabled ||
      next.mode !== this.config.mode ||
      next.lanAddress !== this.config.lanAddress ||
      next.port !== this.config.port ||
      next.publicUrl !== this.config.publicUrl;
    this.config = next;
    if (restart) {
      await this.apply();
    }
    return this.status();
  }

  pair(deviceName: string, readOnly: boolean): RemoteStatus {
    const name = deviceName.trim().slice(0, 40);
    this.pairing.issue(name === '' ? 'Phone' : name, readOnly, this.now().getTime());
    return this.status();
  }

  cancelPairing(): RemoteStatus {
    this.pairing.cancel();
    return this.status();
  }

  async revoke(id: string): Promise<RemoteStatus> {
    const name = this.registry().list().find((d) => d.id === id)?.name ?? id;
    if (await this.registry().revoke(id)) {
      this.deps.log(`remote: revoked "${name}"`);
    }
    return this.status();
  }

  async stop(): Promise<void> {
    await this.gateway.stop();
  }

  private registry(): DeviceRegistry {
    if (this.devices === null) {
      throw new Error('the remote is not initialized');
    }
    return this.devices;
  }

  private async apply(): Promise<void> {
    await this.gateway.stop();
    this.error = null;
    if (!this.config.enabled) {
      this.pairing.cancel();
      return;
    }
    const bind = bindAddressOf(this.config, this.listInterfaces().map((i) => i.address));
    if (!bind.ok) {
      this.error = bind.error;
      return;
    }
    this.bindHost = bind.host;
    this.allowedHosts = allowedHostsOf(this.config, bind.host);
    try {
      await this.gateway.start(bind.host, this.config.port);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      this.error =
        code === 'EADDRINUSE'
          ? `port ${this.config.port} is already in use — choose another`
          : `the server did not start: ${error instanceof Error ? error.message : String(error)}`;
      this.deps.log(`remote: ${this.error}`, 'warn');
    }
  }

  private listInterfaces(): readonly NetworkAddress[] {
    if (this.deps.interfaces !== undefined) {
      return this.deps.interfaces();
    }
    const out: NetworkAddress[] = [];
    for (const [name, entries] of Object.entries(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family === 'IPv4' && !entry.internal) {
          out.push({ name, address: entry.address });
        }
      }
    }
    return out;
  }
}
