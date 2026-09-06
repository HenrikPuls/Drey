/**
 * The LLM debug log's data shape plus the pure helpers around it: secret
 * masking and `curl` reconstruction.
 *
 * Purpose: make every request the app sends to the model endpoint
 * inspectable, and reproducible outside the app. A 401 is almost always
 * one of three things -- no `Authorization` header sent at all, a key the
 * server rejects, or the wrong URL -- and the log distinguishes them
 * instead of leaving you guessing.
 *
 * Secrets: entries are built with the bearer token **already masked**, so
 * the panel (and any screenshot of it) never carries the real key. The
 * renderer re-inserts the real key only when the user explicitly asks for
 * a copyable `curl` command.
 */

export interface LlmDebugEntry {
  /** Monotonic per-session id; also the list key. */
  id: number;
  /** Local wall-clock `HH:mm:ss.mmm` -- these are read next to each other, not sorted. */
  at: string;
  method: 'GET' | 'POST';
  url: string;
  /**
   * Request headers as sent, with the bearer token masked. Lower-cased
   * names, matching what `fetch` receives.
   */
  headers: Record<string, string>;
  /**
   * Whether an `Authorization` header went out at all. Broken out because
   * it is the single most useful bit when debugging a 401 -- `false` plus
   * a 401 means the app never sent the key, which is a different problem
   * from the server rejecting it.
   */
  authSent: boolean;
  /** Request body, truncated. `null` for GET. */
  body: string | null;
  /** HTTP status, or `null` when the request never got a response (transport error/timeout). */
  status: number | null;
  durationMs: number;
  /** Response body, truncated. `null` when there was no response. */
  responseBody: string | null;
  /** Transport-level failure message, or `null`. */
  error: string | null;
}

/** Bodies can be a whole document; keep the log readable and the IPC payload small. */
export const DEBUG_BODY_LIMIT = 2000;

export function truncate(text: string, limit = DEBUG_BODY_LIMIT): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n… [truncated, ${text.length} chars total]`;
}

/**
 * `sk-unsloth-ABCDEF123456` -> `sk-unslo…3456`. Enough to tell which key
 * is in play and that it is non-empty, not enough to use.
 */
export function maskSecret(value: string): string {
  if (value.length <= 6) {
    return '…';
  }
  if (value.length <= 14) {
    return `${value.slice(0, 3)}…${value.slice(-2)}`;
  }
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

/** `Bearer sk-…` -> `Bearer sk-unslo…3456`; anything else is masked whole. */
export function maskAuthorizationHeader(value: string): string {
  const match = /^(\s*Bearer\s+)(.+)$/i.exec(value);
  return match ? `${match[1]}${maskSecret(match[2])}` : maskSecret(value);
}

/** POSIX single-quote quoting: close, escape, reopen. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Rebuilds the request as a runnable `curl` command. `realApiKey`, when
 * given, replaces the masked bearer so the command actually works --
 * that's the "copy with key" path, a deliberate user action. Without it
 * the command is safe to show and share but will 401 on an authed server.
 */
export function toCurl(entry: LlmDebugEntry, realApiKey?: string | null): string {
  const parts = [`curl -X ${entry.method} ${shellQuote(entry.url)}`];
  for (const [name, value] of Object.entries(entry.headers)) {
    const headerValue =
      name.toLowerCase() === 'authorization' && realApiKey ? `Bearer ${realApiKey}` : value;
    parts.push(`  -H ${shellQuote(`${name}: ${headerValue}`)}`);
  }
  if (entry.body !== null) {
    parts.push(`  -d ${shellQuote(entry.body)}`);
  }
  return parts.join(' \\\n');
}
