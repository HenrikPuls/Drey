import { PLUGIN_ID_PATTERN, validateManifest } from '../../../shared/plugin-api/manifest';

describe('validateManifest', () => {
  const valid = {
    id: 'meeting',
    name: 'Meeting import',
    version: '1.0.0',
    apiVersion: 1,
  };

  it('accepts a minimal manifest and fills only the present optionals', () => {
    const result = validateManifest(valid);
    expect('manifest' in result).toBe(true);
    if ('manifest' in result) {
      expect(result.manifest).toEqual(valid);
    }
  });

  it('accepts every optional field', () => {
    const result = validateManifest({
      ...valid,
      description: 'd',
      author: 'a',
      main: 'main/index.js',
      renderer: 'renderer/index.js',
      css: ['renderer/style.css'],
      permissions: ['documents', 'llm'],
    });
    expect('errors' in result).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(validateManifest(null)).toEqual({ errors: ['manifest must be a JSON object'] });
    expect(validateManifest([valid])).toEqual({ errors: ['manifest must be a JSON object'] });
    expect(validateManifest('x')).toEqual({ errors: ['manifest must be a JSON object'] });
  });

  it('rejects ids that are not folder-safe', () => {
    for (const id of ['Meeting', 'a b', '', 'x'.repeat(65), '../escape', 'a/b']) {
      const result = validateManifest({ ...valid, id });
      expect('errors' in result && result.errors.some((e) => e.includes('"id"'))).toBe(true);
    }
    expect(validateManifest({ ...valid, id: 'a1-b' })).toMatchObject({ manifest: { id: 'a1-b' } });
  });

  it('reports every problem at once, not just the first', () => {
    const result = validateManifest({ id: 'Bad Id', apiVersion: 0 });
    expect('errors' in result).toBe(true);
    if ('errors' in result) {
      expect(result.errors.length).toBeGreaterThanOrEqual(3); // id, name, version, apiVersion
    }
  });

  it('rejects a non-positive or fractional apiVersion', () => {
    expect('errors' in validateManifest({ ...valid, apiVersion: 1.5 })).toBe(true);
    expect('errors' in validateManifest({ ...valid, apiVersion: 0 })).toBe(true);
    expect('errors' in validateManifest({ ...valid, apiVersion: -1 })).toBe(true);
    expect('errors' in validateManifest({ ...valid, apiVersion: '1' })).toBe(true);
    expect('errors' in validateManifest({ ...valid, apiVersion: 1 })).toBe(false);
  });

  it('rejects empty entry points and css entries', () => {
    const result = validateManifest({ ...valid, renderer: '  ', css: ['ok.css', ''] });
    expect('errors' in result).toBe(true);
    if ('errors' in result) {
      expect(result.errors.some((e) => e.includes('"renderer"'))).toBe(true);
      expect(result.errors.some((e) => e.includes('"css"'))).toBe(true);
    }
  });

  it('rejects unknown permission names', () => {
    const result = validateManifest({ ...valid, permissions: ['documents', 'root'] });
    expect('errors' in result).toBe(true);
    if ('errors' in result) {
      expect(result.errors.some((e) => e.includes('root'))).toBe(true);
    }
  });

  it('has an id pattern that excludes path separators and dot-segment escapes', () => {
    expect(PLUGIN_ID_PATTERN.test('..')).toBe(false);
    expect(PLUGIN_ID_PATTERN.test('a..b')).toBe(false); // no dots at all — no dot-segment games
    expect(PLUGIN_ID_PATTERN.test('a/b')).toBe(false);
    expect(PLUGIN_ID_PATTERN.test('a\\b')).toBe(false);
    expect(PLUGIN_ID_PATTERN.test('meeting')).toBe(true);
  });
});
