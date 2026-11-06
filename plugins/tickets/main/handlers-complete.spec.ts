import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * D-13: the renderer asked `readTicket` and `archivedTickets` over the plugin IPC and main
 * had no handler for either, so an archived ticket could not open on the desktop while every
 * engine spec was green. A method without a handler only fails at run time; this finds it.
 */
const here = __dirname;

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sources(full);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [full] : [];
  });

describe('the tickets plugin IPC', () => {
  it('has a main handler for every method the renderer invokes', () => {
    const called = new Set<string>();
    for (const file of sources(path.join(here, '..', 'renderer'))) {
      for (const match of readFileSync(file, 'utf8').matchAll(/\b(?:invokeBoard|invoke)\(\s*'([A-Za-z]+)'/g)) {
        called.add(match[1]!);
      }
    }
    const main = sources(here).map((file) => readFileSync(file, 'utf8')).join('\n');
    const missing = [...called].filter((method) => !main.includes(`'${method}'`)).sort();
    expect(called.size).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });

  it('answers the comments of a ticket for the thread (D-12)', () => {
    const index = readFileSync(path.join(here, 'index.ts'), 'utf8');
    expect(index).toMatch(/handle\('ticketComments'/);
  });
});
