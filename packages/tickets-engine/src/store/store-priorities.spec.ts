import { describe, expect, it } from 'vitest';
import { DK_STARTING_PRIORITIES, parseStorePriorities, readStorePriorities } from './store-priorities';

describe('the store priority vocabulary (D-11)', () => {
  it('reads values and default of the [priorities] table, comments and other tables aside', () => {
    const toml = [
      '[security]',
      'values = ["not", "this"]',
      '',
      '[priorities]',
      'values = ["p0", "p1", "p2"]   # allowed values',
      'default = "p1"',
      '',
      '[stages]',
      'values = ["inbox"]',
      'default = "inbox"',
    ].join('\n');
    expect(parseStorePriorities(toml)).toEqual({ order: ['p0', 'p1', 'p2'], default: 'p1' });
  });

  it('applies dk\'s starting set without a table or without values', () => {
    expect(parseStorePriorities('schema_version = 1\n')).toEqual(DK_STARTING_PRIORITIES);
    expect(parseStorePriorities('[priorities]\ndefault = "low"\n')).toEqual(DK_STARTING_PRIORITIES);
  });

  it('takes the first value when the default is not one of the values', () => {
    expect(parseStorePriorities('[priorities]\nvalues = ["a", "b"]\ndefault = "c"\n')).toEqual({ order: ['a', 'b'], default: 'a' });
  });

  it('asks the config refs in dk\'s order and answers unknown when none holds the file', async () => {
    const asked: string[] = [];
    const found = await readStorePriorities('/checkout', async (args) => {
      asked.push(args[1]!);
      if (args[1] !== 'main:dricket.toml') {
        throw new Error('no such ref');
      }
      return '[priorities]\nvalues = ["x"]\n';
    });
    expect(asked).toEqual(['refs/dricket/config:dricket.toml', 'main:dricket.toml']);
    expect(found).toEqual({ order: ['x'], default: 'x' });
    expect(await readStorePriorities('/checkout', () => Promise.reject(new Error('no git')))).toBeNull();
  });
});
