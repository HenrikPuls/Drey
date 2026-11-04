/**
 * Reader for dricket's FLAT front matter (fit-analysis 2.1): one `key: value`
 * per line, no quoting, no nesting, lists as comma-separated text. It is not
 * YAML — `title: First: a colon` is valid here and invalid there — which is
 * why this is its own reader and never `yaml`.
 *
 * Reading only; writing a ticket belongs to `dk`. Tolerant: a malformed line
 * becomes an issue, not an exception, so a board can still render the rest.
 */

export interface FlatDocument {
  /** key -> raw value (empty string for `key:`); the last duplicate wins. */
  readonly fields: Readonly<Record<string, string>>;
  /** Everything after the closing fence, verbatim. */
  readonly body: string;
  readonly issues: readonly string[];
}

const FENCE = '---';

export function parseFlatDocument(text: string): FlatDocument {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trimEnd() !== FENCE) {
    return { fields: {}, body: text, issues: ['no front matter fence'] };
  }
  const fields: Record<string, string> = {};
  const issues: string[] = [];
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trimEnd() === FENCE) {
      end = i;
      break;
    }
    if (line.trim() === '') {
      continue;
    }
    const colon = line.indexOf(':');
    const key = colon > 0 ? line.slice(0, colon) : '';
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) {
      issues.push(`line ${i + 1} is not "key: value"`);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      issues.push(`duplicate key ${key}`);
    }
    fields[key] = line.slice(colon + 1).trim();
  }
  if (end < 0) {
    return { fields, body: '', issues: [...issues, 'front matter is not closed'] };
  }
  return { fields, body: lines.slice(end + 1).join('\n'), issues };
}

/** `a, b ,c` -> `['a','b','c']`; empty / blank -> []. */
export function flatList(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** Empty string -> null. */
export function flatText(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

/** Integer fields (`epoch`, `rev`); anything else -> null. */
export function flatInt(value: string | undefined): number | null {
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}
