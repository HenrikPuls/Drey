import { describe, expect, it } from 'vitest';
import type { ToolSpec } from './llm';
import { checkToolArgs } from './tool-args';

const SEARCH: ToolSpec = {
  name: 'vault_search',
  description: 'Search',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      max_results: { type: 'integer' },
      regex: { type: 'boolean' },
      tags: { type: 'array' },
      mode: { type: 'string', enum: ['text', 'semantic'] },
      anything: {},
    },
    required: ['query'],
  },
};

const error = (argsJson: string): string => {
  const check = checkToolArgs(SEARCH, argsJson);
  return check.ok ? '' : check.error;
};

describe('checkToolArgs', () => {
  it('passes correct arguments through', () => {
    expect(checkToolArgs(SEARCH, '{"query":"boat","max_results":5,"tags":["a"]}')).toEqual({
      ok: true,
      args: { query: 'boat', max_results: 5, tags: ['a'] },
    });
  });

  it('reads an empty string as no arguments', () => {
    const none: ToolSpec = { ...SEARCH, parameters: { type: 'object', properties: {} } };
    expect(checkToolArgs(none, '')).toEqual({ ok: true, args: {} });
  });

  it('names broken JSON and what the tool takes', () => {
    expect(error('{"query":')).toMatch(/not valid JSON .* "query" \(required\)/);
  });

  it('refuses a non-object', () => {
    expect(error('["boat"]')).toMatch(/must be one JSON object, not array/);
  });

  it('names a missing required argument', () => {
    expect(error('{"max_results":5}')).toMatch(/needs the argument "query"/);
    expect(error('{"query":null}')).toMatch(/needs the argument "query"/);
  });

  it('names a wrong type', () => {
    expect(error('{"query":7}')).toMatch(/"query" of vault_search must be string, not number/);
    expect(error('{"query":"a","tags":"x"}')).toMatch(/"tags" .* must be array, not string/);
    expect(error('{"query":"a","max_results":1.5}')).toMatch(/must be integer/);
  });

  it('repairs numbers and booleans sent as strings', () => {
    expect(checkToolArgs(SEARCH, '{"query":"a","max_results":"5","regex":"true"}')).toEqual({
      ok: true,
      args: { query: 'a', max_results: 5, regex: true },
    });
  });

  it('lists the allowed values of an enum', () => {
    expect(error('{"query":"a","mode":"fuzzy"}')).toMatch(
      /"mode" of vault_search must be one of "text", "semantic", not "fuzzy"/,
    );
  });

  it('drops an optional null and leaves an untyped or undeclared argument alone', () => {
    expect(checkToolArgs(SEARCH, '{"query":"a","regex":null,"anything":[1],"extra":1}')).toEqual({
      ok: true,
      args: { query: 'a', anything: [1], extra: 1 },
    });
  });
});
