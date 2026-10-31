import { describe, expect, it, vi } from 'vitest';
import { isLocalName, isPrivateAddress, runWebFetch, type AddressLookup } from './web-fetch';

/**
 * The private-address guard of `web_fetch` (ADR-0063): the model must
 * never probe the machine or its LAN through a fetched URL — not by
 * literal address, not by a local name, not through a redirect, and not
 * through a public name that resolves into the local network.
 */

const PUBLIC: AddressLookup = async () => [{ address: '93.184.216.34' }];

/** A lookup that records what it was asked and answers from a script. */
function lookupAnswer(addresses: string[]): { lookup: AddressLookup; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    lookup: async (host: string) => {
      asked.push(host);
      return addresses.map((address) => ({ address }));
    },
  };
}

describe('isPrivateAddress — literal addresses', () => {
  it('refuses the private and special IPv4 ranges', () => {
    for (const ip of [
      '0.0.0.0',
      '0.1.2.3',
      '10.0.0.5',
      '10.255.1.1',
      '127.0.0.1',
      '169.254.9.9',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.4',
      '100.64.0.1',
      '100.79.255.255',
      '255.255.255.255',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('allows public IPv4 addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '100.63.0.1', '100.80.0.1', '93.184.216.34']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('refuses the special IPv6 ranges and the mapped v4 forms', () => {
    for (const ip of [
      '::',
      '::1',
      'fc00::1',
      'fd12:3456:789a::1',
      'fe80::1',
      'febf::1',
      '2002:abcd::1',
      '64:ff9b::808:808',
      // IPv4-mapped, dotted and hex (URLs re-serialize to the hex form)
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:7f00:1',
      '::ffff:a00:1',
      // The bracketed shape URL.hostname hands out
      '[::1]',
      '[::ffff:7f00:1]',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('allows public IPv6 addresses and names', () => {
    for (const host of ['2001:db8::1', '::ffff:8.8.8.8', 'fe00::1', '[2001:db8::1]', 'example.com']) {
      expect(isPrivateAddress(host), host).toBe(false);
    }
  });
});

describe('isLocalName — refused without a lookup', () => {
  it('refuses the machine-local name suffixes', () => {
    for (const name of ['localhost', 'app.localhost', 'printer.local', 'wiki.internal', 'a.b.local']) {
      expect(isLocalName(name), name).toBe(true);
    }
    for (const name of ['example.com', 'internal', 'localhost.example.com', 'mylocal.net']) {
      expect(isLocalName(name), name).toBe(false);
    }
  });
});

describe('runWebFetch — the guard', () => {
  it('refuses a literal private address without fetching or looking up', async () => {
    const fetchFn = vi.fn();
    const lookup = vi.fn();
    for (const url of [
      'http://10.0.0.5/',
      'http://127.0.0.1:8080/',
      'http://192.168.1.4/x',
      'http://172.19.0.1/',
      'http://[::1]/',
      'http://[::ffff:7f00:1]/',
      'http://[fc00::1]/',
    ]) {
      const result = await runWebFetch({ url }, undefined, fetchFn as never, lookup as never);
      expect(result, url).toMatch(/^Error: /);
      expect(result, url).toMatch(/does not reach it/);
    }
    expect(fetchFn).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses localhost and the local name suffixes without a lookup', async () => {
    const fetchFn = vi.fn();
    const lookup = vi.fn();
    for (const url of ['http://localhost/', 'http://app.localhost/', 'http://printer.local/', 'http://wiki.internal/']) {
      const result = await runWebFetch({ url }, undefined, fetchFn as never, lookup as never);
      expect(result, url).toMatch(/^Error: .*local name/);
    }
    expect(fetchFn).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses a public name that resolves into the local network', async () => {
    const fetchFn = vi.fn();
    const { lookup, asked } = lookupAnswer(['93.184.216.34', '10.1.2.3']);

    const result = await runWebFetch(
      { url: 'https://public.example/x' },
      undefined,
      fetchFn as never,
      lookup,
    );

    expect(asked).toEqual(['public.example']);
    expect(result).toMatch(/^Error: .*resolves to an address of the local network/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('fetches a public name with the unmocked call shape', async () => {
    const fetchFn = vi.fn(async () => new Response('body', { headers: { 'content-type': 'text/plain' } }));
    const { lookup } = lookupAnswer(['93.184.216.34']);

    const result = await runWebFetch(
      { url: 'https://public.example/x' },
      undefined,
      fetchFn as never,
      lookup,
    );

    expect(result).toBe('body');
    expect(fetchFn).toHaveBeenCalledExactlyOnceWith(
      new URL('https://public.example/x'),
      expect.objectContaining({
        redirect: 'manual',
        headers: expect.objectContaining({ 'User-Agent': 'Drey' }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('refuses a redirect that leads into the local network', async () => {
    const fetchFn = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/admin' } }),
    );

    const result = await runWebFetch(
      { url: 'https://public.example/' },
      undefined,
      fetchFn as never,
      PUBLIC,
    );

    expect(result).toMatch(/^Error: .*10\.0\.0\.1.*does not reach it/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('follows a chain of public redirects, a relative Location included', async () => {
    const seen: string[] = [];
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      seen.push(String(input));
      if (seen.length === 1) {
        return new Response(null, { status: 301, headers: { location: 'https://other.example/' } });
      }
      if (seen.length === 2) {
        return new Response(null, { status: 302, headers: { location: '/final' } });
      }
      return new Response('done', { headers: { 'content-type': 'text/plain' } });
    });

    const result = await runWebFetch(
      { url: 'https://public.example/a' },
      undefined,
      fetchFn as never,
      PUBLIC,
    );

    expect(result).toBe('done');
    expect(seen).toEqual([
      'https://public.example/a',
      'https://other.example/',
      'https://other.example/final',
    ]);
  });

  it('stops after five redirects instead of looping forever', async () => {
    const fetchFn = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'https://public.example/loop' } }),
    );

    const result = await runWebFetch(
      { url: 'https://public.example/' },
      undefined,
      fetchFn as never,
      PUBLIC,
    );

    expect(result).toMatch(/^Error: too many redirects/);
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });

  it('still refuses non-http URLs outright', async () => {
    const fetchFn = vi.fn();
    const result = await runWebFetch(
      { url: 'file:///etc/passwd' },
      undefined,
      fetchFn as never,
      PUBLIC,
    );
    expect(result).toMatch(/^Error: only http and https/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('turns a failed name lookup into Error: text, not a crash', async () => {
    const fetchFn = vi.fn();
    const lookup: AddressLookup = async () => {
      throw new Error('getaddrinfo ENOTFOUND nope.test');
    };

    const result = await runWebFetch(
      { url: 'https://nope.test/x' },
      undefined,
      fetchFn as never,
      lookup,
    );

    expect(result).toMatch(/^Error: could not fetch https:\/\/nope\.test\/x: .*ENOTFOUND/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
