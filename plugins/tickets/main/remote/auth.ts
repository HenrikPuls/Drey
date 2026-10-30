/**
 * The remote's access control (req-66, ADR-0086): single-use pairing
 * codes, paired devices behind hashed tokens, and a failure limiter.
 * Only SHA-256 hashes of device tokens are kept — the plain token
 * exists once, in the pairing reply, and then only on the device.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** Crockford base32 without the look-alikes — the code may be typed. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIRING_CODE_LENGTH = 10;
export const PAIRING_TTL_MS = 5 * 60_000;

export interface RemoteDevice {
  readonly id: string;
  readonly name: string;
  readonly readOnly: boolean;
  /** SHA-256 of the device token, hex. */
  readonly tokenHash: string;
  readonly pairedAt: string;
  readonly lastSeen: string | null;
}

/** What Settings shows — never the hash. */
export type DeviceView = Omit<RemoteDevice, 'tokenHash'>;

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A typed code reads case-blind and forgives the look-alikes and separators. */
export function normalizePairingCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

export interface PendingPairing {
  readonly code: string;
  readonly deviceName: string;
  readonly readOnly: boolean;
  readonly expiresAt: number;
}

/** At most one pairing waits at a time; a new one replaces it. */
export class PairingCodes {
  private pending: PendingPairing | null = null;

  issue(deviceName: string, readOnly: boolean, now: number): PendingPairing {
    let code = '';
    for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
      code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    this.pending = { code, deviceName, readOnly, expiresAt: now + PAIRING_TTL_MS };
    return this.pending;
  }

  current(now: number): PendingPairing | null {
    if (this.pending !== null && now >= this.pending.expiresAt) {
      this.pending = null;
    }
    return this.pending;
  }

  cancel(): void {
    this.pending = null;
  }

  /** The waiting pairing when `code` matches it; it is used up either way only on a match. */
  consume(code: string, now: number): PendingPairing | null {
    const pending = this.current(now);
    if (pending === null || !sameText(normalizePairingCode(code), pending.code)) {
      return null;
    }
    this.pending = null;
    return pending;
  }
}

/** The paired devices; `save` persists the list after every change. */
export class DeviceRegistry {
  private devices: RemoteDevice[];

  constructor(
    initial: readonly RemoteDevice[],
    private readonly save: (devices: readonly RemoteDevice[]) => Promise<void>,
  ) {
    this.devices = initial.filter(isDevice);
  }

  list(): readonly DeviceView[] {
    return this.devices.map(({ tokenHash: _hash, ...view }) => view);
  }

  async add(name: string, readOnly: boolean, now: Date): Promise<{ device: DeviceView; token: string }> {
    const token = randomBytes(32).toString('base64url');
    const device: RemoteDevice = {
      id: randomBytes(8).toString('hex'),
      name,
      readOnly,
      tokenHash: hashToken(token),
      pairedAt: now.toISOString(),
      lastSeen: null,
    };
    this.devices = [...this.devices, device];
    await this.save(this.devices);
    const { tokenHash: _hash, ...view } = device;
    return { device: view, token };
  }

  /** The device a bearer token belongs to, or null. */
  byToken(token: string): RemoteDevice | null {
    const hash = hashToken(token);
    return this.devices.find((d) => sameText(d.tokenHash, hash)) ?? null;
  }

  async revoke(id: string): Promise<boolean> {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length === before) {
      return false;
    }
    await this.save(this.devices);
    return true;
  }

  /** Marks the device seen; persisted at most once a minute per device. */
  async touch(id: string, now: Date): Promise<void> {
    const device = this.devices.find((d) => d.id === id);
    if (device === undefined) {
      return;
    }
    const last = device.lastSeen === null ? 0 : Date.parse(device.lastSeen);
    if (now.getTime() - last < 60_000) {
      return;
    }
    this.devices = this.devices.map((d) => (d.id === id ? { ...d, lastSeen: now.toISOString() } : d));
    await this.save(this.devices);
  }
}

function isDevice(value: unknown): value is RemoteDevice {
  const d = value as Partial<RemoteDevice> | null;
  return (
    typeof d === 'object' &&
    d !== null &&
    typeof d.id === 'string' &&
    typeof d.name === 'string' &&
    typeof d.tokenHash === 'string' &&
    /^[0-9a-f]{64}$/.test(d.tokenHash) &&
    typeof d.readOnly === 'boolean' &&
    typeof d.pairedAt === 'string'
  );
}

/**
 * Failed authentications per client address: after `max` failures
 * inside the window the address is refused until the window has passed
 * since its first failure. Behind Tailscale Serve every request comes
 * from loopback, so the limit is then global — the stricter reading.
 */
export class FailureLimiter {
  private readonly failures = new Map<string, { first: number; count: number }>();

  constructor(
    private readonly max = 10,
    private readonly windowMs = 10 * 60_000,
  ) {}

  blocked(key: string, now: number): boolean {
    const entry = this.failures.get(key);
    if (entry === undefined) {
      return false;
    }
    if (now - entry.first >= this.windowMs) {
      this.failures.delete(key);
      return false;
    }
    return entry.count >= this.max;
  }

  fail(key: string, now: number): void {
    const entry = this.failures.get(key);
    if (entry === undefined || now - entry.first >= this.windowMs) {
      this.failures.set(key, { first: now, count: 1 });
    } else {
      entry.count++;
    }
  }
}
