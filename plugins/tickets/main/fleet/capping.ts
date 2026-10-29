/**
 * Output capping (T-0048): every text the runner injects into an
 * instruction — a gate failure's tail, a diff stat's head — is bounded
 * here, lines first and bytes second, so a verbose gate never drags a
 * whole build log into the worker's context. The byte cut walks code
 * points: a surrogate pair is never split.
 *
 * Pure — the callers decide what to cap and log the truncation.
 */

export interface CapLimits {
  readonly lines: number;
  readonly bytes: number;
}

export interface Capped {
  readonly text: string;
  /** True when anything was removed (a line, a byte, or both). */
  readonly truncated: boolean;
  /** The original's size in UTF-8 bytes — what the caller logs. */
  readonly originalSize: number;
}

/**
 * The hard bound `runGate` stores on `RunInfo.gateFailure` before the
 * configurable tail cap applies at injection: `run.json` must stay sane
 * even for a gate that dumped thousands of lines.
 */
export const SANITY_CAP: CapLimits = { lines: 400, bytes: 64 * 1024 };

/** The largest prefix (in UTF-8 bytes) that fits the budget, code points intact. */
function cutHeadBytes(text: string, maxBytes: number): string {
  let used = 0;
  let end = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > maxBytes) {
      break;
    }
    used += size;
    end += ch.length;
  }
  return text.slice(0, end);
}

/** The largest suffix (in UTF-8 bytes) that fits the budget, code points intact. */
function cutTailBytes(text: string, maxBytes: number): string {
  const chars = [...text];
  let used = 0;
  let start = chars.length;
  while (start > 0) {
    const size = Buffer.byteLength(chars[start - 1]!, 'utf8');
    if (used + size > maxBytes) {
      break;
    }
    used += size;
    start--;
  }
  return chars.slice(start).join('');
}

/** Keeps the text's first lines (a trailing newline's empty piece is no line). */
export function capHead(text: string, limits: CapLimits): Capped {
  const originalSize = Buffer.byteLength(text, 'utf8');
  const pieces = text.split('\n');
  const visibleLines = pieces.length - (text.endsWith('\n') ? 1 : 0);
  let capped =
    visibleLines > limits.lines ? pieces.slice(0, limits.lines).join('\n') : text;
  if (Buffer.byteLength(capped, 'utf8') > limits.bytes) {
    capped = cutHeadBytes(capped, limits.bytes);
  }
  return { text: capped, truncated: capped !== text, originalSize };
}

/** Keeps the text's last lines (a trailing newline's empty piece is no line). */
export function capTail(text: string, limits: CapLimits): Capped {
  const originalSize = Buffer.byteLength(text, 'utf8');
  const pieces = text.split('\n');
  const visibleLines = pieces.length - (text.endsWith('\n') ? 1 : 0);
  let capped =
    visibleLines > limits.lines ? pieces.slice(visibleLines - limits.lines).join('\n') : text;
  if (Buffer.byteLength(capped, 'utf8') > limits.bytes) {
    capped = cutTailBytes(capped, limits.bytes);
  }
  return { text: capped, truncated: capped !== text, originalSize };
}
