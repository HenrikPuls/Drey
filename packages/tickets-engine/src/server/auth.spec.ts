import { describe, expect, it, vi } from 'vitest';
import {
  DeviceRegistry,
  FailureLimiter,
  hashToken,
  normalizePairingCode,
  PAIRING_CODE_LENGTH,
  PAIRING_TTL_MS,
  PairingCodes,
  type RemoteDevice,
} from './auth';

/** req-66: pairing codes, hashed device tokens, the failure limiter. */

describe('PairingCodes', () => {
  it('issues a typeable code that is used up on the first match', () => {
    const codes = new PairingCodes();
    const p = codes.issue('iPad', false, 0);
    expect(p.code).toMatch(new RegExp(`^[0-9A-HJKMNP-TV-Z]{${PAIRING_CODE_LENGTH}}$`));
    expect(codes.consume('WRONG00000', 1)).toBeNull();
    const typed = `${p.code.slice(0, 5).toLowerCase()}-${p.code.slice(5)}`;
    expect(codes.consume(typed, 1)).toEqual(p);
    expect(codes.consume(p.code, 2)).toBeNull();
  });

  it('expires after five minutes, and a new code replaces the old one', () => {
    const codes = new PairingCodes();
    const first = codes.issue('a', false, 0);
    const second = codes.issue('b', true, 0);
    expect(codes.consume(first.code, 1)).toBeNull();
    expect(codes.current(PAIRING_TTL_MS - 1)).toEqual(second);
    expect(codes.consume(second.code, PAIRING_TTL_MS)).toBeNull();
  });

  it('reads the look-alikes as digits', () => {
    expect(normalizePairingCode(' o1-il ')).toBe('0111');
  });
});

describe('DeviceRegistry', () => {
  it('keeps only the token hash and finds the device by its token', async () => {
    const save = vi.fn(async (_devices: readonly RemoteDevice[]) => undefined);
    const registry = new DeviceRegistry([], save);
    const { device, token } = await registry.add('iPhone', false, new Date('2026-10-30T10:00:00Z'));
    expect(token.length).toBeGreaterThanOrEqual(40);
    const saved = save.mock.calls[0]![0];
    expect(saved[0]!.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(saved)).not.toContain(token);
    expect(registry.byToken(token)?.id).toBe(device.id);
    expect(registry.byToken(`${token}x`)).toBeNull();
    expect(registry.list()[0]).not.toHaveProperty('tokenHash');
  });

  it('revokes a device and drops unreadable stored entries', async () => {
    const good: RemoteDevice = {
      id: 'd1',
      name: 'iPad',
      readOnly: true,
      tokenHash: hashToken('t'.repeat(43)),
      pairedAt: '2026-10-30T10:00:00Z',
      lastSeen: null,
    };
    const registry = new DeviceRegistry([good, { id: 'x' } as unknown as RemoteDevice], async () => undefined);
    expect(registry.list().map((d) => d.id)).toEqual(['d1']);
    expect(await registry.revoke('d1')).toBe(true);
    expect(registry.byToken('t'.repeat(43))).toBeNull();
    expect(await registry.revoke('d1')).toBe(false);
  });

  it('persists "last seen" at most once a minute', async () => {
    const save = vi.fn(async () => undefined);
    const registry = new DeviceRegistry([], save);
    const { device } = await registry.add('p', false, new Date(0));
    save.mockClear();
    await registry.touch(device.id, new Date(120_000));
    await registry.touch(device.id, new Date(150_000));
    await registry.touch(device.id, new Date(181_000));
    expect(save).toHaveBeenCalledTimes(2);
  });
});

describe('FailureLimiter', () => {
  it('blocks after the max failures until the window passed', () => {
    const limiter = new FailureLimiter(3, 1000);
    for (let i = 0; i < 3; i++) {
      expect(limiter.blocked('a', i)).toBe(false);
      limiter.fail('a', i);
    }
    expect(limiter.blocked('a', 10)).toBe(true);
    expect(limiter.blocked('b', 10)).toBe(false);
    expect(limiter.blocked('a', 1000)).toBe(false);
  });
});
