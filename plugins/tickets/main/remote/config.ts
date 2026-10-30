/**
 * The remote's settings (req-66, ADR-0084) and the pure decisions made
 * from them: where the gateway binds, which Host headers it answers,
 * and the address a device opens. Kept in the plugin's own config under
 * `remote.*`; the paired devices live beside them in `remote.devices`.
 */

export type RemoteMode = 'loopback' | 'lan';

export interface RemoteConfig {
  readonly enabled: boolean;
  /** `loopback` binds 127.0.0.1 (reach through Tailscale Serve); `lan` binds `lanAddress`. */
  readonly mode: RemoteMode;
  /** The IPv4 address of the interface LAN mode binds — never 0.0.0.0. */
  readonly lanAddress: string | null;
  readonly port: number;
  /** The address the device opens (`https://desk.tail1234.ts.net`); null = derived. */
  readonly publicUrl: string | null;
  /** Bypass-permission runs from a device (off by default). */
  readonly allowBypass: boolean;
}

export const DEFAULT_REMOTE_PORT = 47811;

export const REMOTE_CONFIG_KEYS = {
  enabled: 'remote.enabled',
  mode: 'remote.mode',
  lanAddress: 'remote.lanAddress',
  port: 'remote.port',
  publicUrl: 'remote.publicUrl',
  allowBypass: 'remote.allowBypass',
  devices: 'remote.devices',
} as const;

/** Anything unreadable degrades to the safe default (off, loopback). */
export function normalizeRemoteConfig(raw: Partial<Record<keyof RemoteConfig, unknown>>): RemoteConfig {
  const port = typeof raw.port === 'number' && Number.isInteger(raw.port) && raw.port >= 1024 && raw.port <= 65535
    ? raw.port
    : DEFAULT_REMOTE_PORT;
  const lan = typeof raw.lanAddress === 'string' && isIpv4(raw.lanAddress.trim()) ? raw.lanAddress.trim() : null;
  return {
    enabled: raw.enabled === true,
    mode: raw.mode === 'lan' ? 'lan' : 'loopback',
    lanAddress: lan !== null && lan !== '0.0.0.0' ? lan : null,
    port,
    publicUrl: normalizePublicUrl(raw.publicUrl),
    allowBypass: raw.allowBypass === true,
  };
}

function isIpv4(text: string): boolean {
  const parts = text.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** An http(s) origin without path, query or fragment; anything else is null. */
export function normalizePublicUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }
  try {
    const url = new URL(raw.trim());
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '') {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/** The address the server listens on, or why it cannot. */
export function bindAddressOf(
  config: RemoteConfig,
  interfaceAddresses: readonly string[],
): { readonly ok: true; readonly host: string } | { readonly ok: false; readonly error: string } {
  if (config.mode === 'loopback') {
    return { ok: true, host: '127.0.0.1' };
  }
  if (config.lanAddress === null) {
    return { ok: false, error: 'choose the network interface the board is offered on' };
  }
  if (!interfaceAddresses.includes(config.lanAddress)) {
    return { ok: false, error: `${config.lanAddress} is not an address of this computer right now` };
  }
  return { ok: true, host: config.lanAddress };
}

/**
 * The Host headers the gateway answers (lowercase `host[:port]`). A
 * request naming any other host is refused — that is what stops a web
 * page whose DNS name was rebound to this machine from reaching it.
 */
export function allowedHostsOf(config: RemoteConfig, bindHost: string): ReadonlySet<string> {
  const hosts = new Set<string>([`${bindHost}:${config.port}`]);
  if (bindHost === '127.0.0.1') {
    hosts.add(`localhost:${config.port}`);
  }
  if (config.publicUrl !== null) {
    const url = new URL(config.publicUrl);
    hosts.add(url.host.toLowerCase());
    // An explicit default port in the Host header names the same origin.
    if (url.port === '') {
      hosts.add(`${url.hostname.toLowerCase()}:${url.protocol === 'https:' ? 443 : 80}`);
    }
  }
  return hosts;
}

export function hostAllowed(hostHeader: string | undefined, allowed: ReadonlySet<string>): boolean {
  return hostHeader !== undefined && allowed.has(hostHeader.trim().toLowerCase());
}

/**
 * A writing request from a browser must come from the gateway's own
 * page: its Origin names an allowed host. A request without Origin is a
 * non-browser client (curl) — it still needs the bearer token, which no
 * other page can read, so there is nothing to forge.
 */
export function originAllowed(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (origin === undefined) {
    return true;
  }
  if (origin === 'null') {
    return false;
  }
  try {
    return allowed.has(new URL(origin).host.toLowerCase());
  } catch {
    return false;
  }
}

/** The page a device opens; `#pair=<code>` rides in the fragment, which never reaches a server or a log. */
export function deviceUrlOf(config: RemoteConfig, bindHost: string): string {
  return config.publicUrl ?? `http://${bindHost}:${config.port}`;
}

export function pairingUrlOf(base: string, code: string): string {
  return `${base}/#pair=${code}`;
}
