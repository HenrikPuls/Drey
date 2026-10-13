/**
 * Checks the arguments a model sent for a tool call against the tool's
 * declared parameters, before the tool runs (ADR-0071). Pure.
 *
 * Deliberately shallow: the top-level properties only, and only what a
 * small model gets wrong in practice — broken JSON, a missing required
 * argument, a wrong primitive type, a value outside an `enum`. A number
 * or boolean sent as a string ("5", "true") is repaired instead of
 * refused. Every refusal is worded for the model: it names the argument
 * and what a correct call looks like, so the next round can fix it.
 */
import type { ToolSpec } from './llm';

export type ToolArgsCheck =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

interface PropertySchema {
  type?: unknown;
  enum?: unknown;
}

const RAW_ECHO_LIMIT = 200;

function describeType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  return Array.isArray(value) ? 'array' : typeof value;
}

/** The value in the declared type, repaired where that is unambiguous; `undefined` when it does not fit. */
function coerce(value: unknown, type: string): unknown {
  switch (type) {
    case 'string':
      return typeof value === 'string' ? value : undefined;
    case 'number':
    case 'integer': {
      const parsed =
        typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
        return undefined;
      }
      return type === 'integer' && !Number.isInteger(parsed) ? undefined : parsed;
    }
    case 'boolean':
      if (value === 'true') {
        return true;
      }
      if (value === 'false') {
        return false;
      }
      return typeof value === 'boolean' ? value : undefined;
    case 'array':
      return Array.isArray(value) ? value : undefined;
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
    default:
      // A schema this check does not understand (a union, a `$ref`): pass.
      return value;
  }
}

function usage(spec: ToolSpec): string {
  const required = spec.parameters.required ?? [];
  const names = Object.keys(spec.parameters.properties);
  if (names.length === 0) {
    return `${spec.name} takes no arguments: {}`;
  }
  const parts = names.map((name) => (required.includes(name) ? `"${name}" (required)` : `"${name}"`));
  return `Arguments of ${spec.name}: ${parts.join(', ')}.`;
}

/** Parses `argsJson` and checks it against `spec`; on success the (repaired) arguments come back. */
export function checkToolArgs(spec: ToolSpec, argsJson: string): ToolArgsCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson.trim() === '' ? '{}' : argsJson);
  } catch {
    return {
      ok: false,
      error: `Error: the arguments of ${spec.name} are not valid JSON (${argsJson.slice(0, RAW_ECHO_LIMIT)}) — send one JSON object. ${usage(spec)}`,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      error: `Error: the arguments of ${spec.name} must be one JSON object, not ${describeType(parsed)}. ${usage(spec)}`,
    };
  }
  const args: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };

  for (const name of spec.parameters.required ?? []) {
    if (args[name] === undefined || args[name] === null) {
      return {
        ok: false,
        error: `Error: ${spec.name} needs the argument "${name}" — call it again with "${name}" set. ${usage(spec)}`,
      };
    }
  }

  for (const [name, raw] of Object.entries(spec.parameters.properties)) {
    const value = args[name];
    if (value === undefined || value === null) {
      delete args[name];
      continue;
    }
    const schema = (raw ?? {}) as PropertySchema;
    if (typeof schema.type === 'string') {
      const fitted = coerce(value, schema.type);
      if (fitted === undefined) {
        return {
          ok: false,
          error: `Error: the argument "${name}" of ${spec.name} must be ${schema.type}, not ${describeType(value)} — call it again with a ${schema.type} value.`,
        };
      }
      args[name] = fitted;
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(args[name])) {
      return {
        ok: false,
        error: `Error: the argument "${name}" of ${spec.name} must be one of ${schema.enum
          .map((option) => JSON.stringify(option))
          .join(', ')}, not ${JSON.stringify(args[name])}.`,
      };
    }
  }
  return { ok: true, args };
}
