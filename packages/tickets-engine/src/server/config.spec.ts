import { describe, expect, it } from 'vitest';
import {
  allowedHostsOf,
  bindAddressOf,
  DEFAULT_REMOTE_PORT,
  hostAllowed,
  normalizePublicUrl,
  normalizeRemoteConfig,
  originAllowed,
  pairingUrlOf,
} from './config';

/** req-66: the remote's settings and the bind / Host decisions made from them. */

describe('normalizeRemoteConfig', () => {
  it('defaults to off, loopback, the default port, no bypass', () => {
    expect(normalizeRemoteConfig({})).toEqual({
      enabled: false,
      mode: 'loopback',
      lanAddress: null,
      port: DEFAULT_REMOTE_PORT,
      publicUrl: null,
      allowBypass: false,
    });
  });

  it('drops a privileged port, a wildcard bind and a malformed address', () => {
    const c = normalizeRemoteConfig({ mode: 'lan', port: 80, lanAddress: '0.0.0.0' });
    expect(c.port).toBe(DEFAULT_REMOTE_PORT);
    expect(c.lanAddress).toBeNull();
    expect(normalizeRemoteConfig({ lanAddress: '192.168.1.300' }).lanAddress).toBeNull();
    expect(normalizeRemoteConfig({ lanAddress: ' 192.168.1.20 ' }).lanAddress).toBe('192.168.1.20');
  });

  it('keeps only the origin of a public URL', () => {
    expect(normalizePublicUrl('https://desk.tail1.ts.net/some/path?x#y')).toBe('https://desk.tail1.ts.net');
    expect(normalizePublicUrl('ftp://desk')).toBeNull();
    expect(normalizePublicUrl('https://user:pw@desk')).toBeNull();
    expect(normalizePublicUrl('not a url')).toBeNull();
  });
});

describe('bind and host decisions', () => {
  it('binds loopback, or the chosen LAN address only while this computer has it', () => {
    expect(bindAddressOf(normalizeRemoteConfig({}), [])).toEqual({ ok: true, host: '127.0.0.1' });
    const lan = normalizeRemoteConfig({ mode: 'lan', lanAddress: '192.168.1.20' });
    expect(bindAddressOf(lan, ['192.168.1.20'])).toEqual({ ok: true, host: '192.168.1.20' });
    expect(bindAddressOf(lan, ['10.0.0.2'])).toMatchObject({ ok: false });
    expect(bindAddressOf(normalizeRemoteConfig({ mode: 'lan' }), [])).toMatchObject({ ok: false });
  });

  it('answers the bound address, localhost on loopback, and the public host', () => {
    const c = normalizeRemoteConfig({ publicUrl: 'https://desk.tail1.ts.net' });
    const hosts = allowedHostsOf(c, '127.0.0.1');
    expect([...hosts].sort()).toEqual(
      ['127.0.0.1:47811', 'desk.tail1.ts.net', 'desk.tail1.ts.net:443', 'localhost:47811'].sort(),
    );
    expect(hostAllowed('DESK.tail1.ts.net', hosts)).toBe(true);
    expect(hostAllowed('evil.example', hosts)).toBe(false);
    expect(hostAllowed(undefined, hosts)).toBe(false);
  });

  it('refuses a foreign or opaque Origin, lets a non-browser client without one pass', () => {
    const hosts = allowedHostsOf(normalizeRemoteConfig({}), '127.0.0.1');
    expect(originAllowed('http://127.0.0.1:47811', hosts)).toBe(true);
    expect(originAllowed('http://evil.example', hosts)).toBe(false);
    expect(originAllowed('null', hosts)).toBe(false);
    expect(originAllowed(undefined, hosts)).toBe(true);
  });

  it('carries the pairing code in the fragment', () => {
    expect(pairingUrlOf('https://desk', 'ABCDE12345')).toBe('https://desk/#pair=ABCDE12345');
  });
});
