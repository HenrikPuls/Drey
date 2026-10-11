/**
 * Keeps the secrets of `app-config.json` encrypted on disk (ADR-0010,
 * later change). Only the secret fields are touched -- the API key of the
 * LLM connection and, per external MCP server, the values of its
 * environment variables and HTTP headers. Everything else in the file
 * stays plain, readable and hand-editable.
 *
 * A sealed value is the string `enc:v1:<base64>`; the bytes come from the
 * OS (Electron `safeStorage`: DPAPI on Windows, the keychain on macOS, the
 * secret service on Linux) and can only be opened by the same OS user on
 * the same machine. A plain value in one of these fields is still read --
 * that is how a key typed into the file by hand, or one written by an
 * older version, gets in -- and is sealed with the next write.
 *
 * In memory, and over IPC to the Settings screen, the config always holds
 * the plain values. Kept free of Electron imports so it is testable in
 * plain Node; the store passes the cipher in.
 */
import type { AppConfig } from '../shared/app-config';

/** The part of `safeStorage` this module needs. */
export interface SecretCipher {
  /** False when the OS offers no real protection; values then stay plain. */
  isAvailable(): boolean;
  encrypt(plain: string): Uint8Array;
  decrypt(sealed: Uint8Array): string;
}

const SEALED_PREFIX = 'enc:v1:';

export function isSealed(value: string): boolean {
  return value.startsWith(SEALED_PREFIX);
}

/**
 * Applies `fn` to every secret of the config and returns the changed copy.
 * `label` names the secret the way the user would recognise it. This one
 * walk is the definition of what counts as a secret.
 */
function mapSecrets(
  config: AppConfig,
  fn: (value: string, label: string) => string | null,
): AppConfig {
  const mapValues = (
    values: Record<string, string>,
    label: (key: string) => string,
  ): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      out[key] = value === '' ? value : (fn(value, label(key)) ?? '');
    }
    return out;
  };
  return {
    ...config,
    llm: {
      ...config.llm,
      apiKey: config.llm.apiKey === null ? null : fn(config.llm.apiKey, 'LLM API key'),
    },
    tools: {
      ...config.tools,
      servers: config.tools.servers.map((server) => ({
        ...server,
        transport:
          server.transport.kind === 'http'
            ? {
                ...server.transport,
                headers: mapValues(
                  server.transport.headers,
                  (key) => `MCP server "${server.name}": header ${key}`,
                ),
              }
            : {
                ...server.transport,
                env: mapValues(
                  server.transport.env,
                  (key) => `MCP server "${server.name}": environment variable ${key}`,
                ),
              },
      })),
    },
  };
}

/** The config as it goes to disk: every secret sealed, if the OS can. */
export function sealConfigSecrets(config: AppConfig, cipher: SecretCipher): AppConfig {
  if (!cipher.isAvailable()) {
    return config;
  }
  return mapSecrets(config, (value) =>
    isSealed(value)
      ? value
      : SEALED_PREFIX + Buffer.from(cipher.encrypt(value)).toString('base64'),
  );
}

export interface OpenedConfig {
  /** The config with plain secrets, as the app uses it. */
  config: AppConfig;
  /** Labels of sealed secrets that could not be opened; they are now empty. */
  lost: string[];
  /** True when the file held a secret in plain text. */
  hadPlainSecrets: boolean;
}

/**
 * The config as read from disk, with its sealed secrets opened. A sealed
 * value that cannot be opened -- the file came from another machine or
 * user, or the OS store is not reachable -- becomes empty and is named in
 * `lost`; nothing else in the config is affected.
 */
export function openConfigSecrets(config: AppConfig, cipher: SecretCipher): OpenedConfig {
  const lost: string[] = [];
  let hadPlainSecrets = false;
  const available = cipher.isAvailable();
  const opened = mapSecrets(config, (value, label) => {
    if (!isSealed(value)) {
      hadPlainSecrets = true;
      return value;
    }
    if (available) {
      try {
        return cipher.decrypt(Buffer.from(value.slice(SEALED_PREFIX.length), 'base64'));
      } catch {
        // falls through to "lost"
      }
    }
    lost.push(label);
    return null;
  });
  return { config: opened, lost, hadPlainSecrets };
}
