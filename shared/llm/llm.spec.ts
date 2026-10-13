import { extractJsonObject, parseJsonObject } from './index';

describe('extractJsonObject', () => {
  it('returns a bare object unchanged', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it('pulls the object out of a fenced, prose-wrapped reply', () => {
    expect(extractJsonObject('Sure:\n```json\n{"a": {"b": 2}}\n```\nDone')).toBe('{"a": {"b": 2}}');
  });

  it('ignores braces inside strings', () => {
    expect(extractJsonObject('{"text":"a } b { c"}')).toBe('{"text":"a } b { c"}');
  });

  it('returns null when there is no object', () => {
    expect(extractJsonObject('no json')).toBeNull();
    expect(extractJsonObject('{ unbalanced')).toBeNull();
  });
});

describe('parseJsonObject', () => {
  it('parses to a plain object', () => {
    expect(parseJsonObject('prefix {"k":"v"} suffix')).toEqual({ k: 'v' });
  });

  it('returns null for an array or invalid JSON', () => {
    expect(parseJsonObject('[1,2,3]')).toBeNull();
    expect(parseJsonObject('{"k": }')).toBeNull();
  });
});
