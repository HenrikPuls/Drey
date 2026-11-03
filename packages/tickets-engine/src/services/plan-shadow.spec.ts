import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilePlanShadowStore, MemoryPlanShadowStore } from './plan-shadow';

describe('the plan shadow stores', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(tmpdir(), 'plan-shadow-'));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('remembers a shadow per ticket in memory', async () => {
    const store = new MemoryPlanShadowStore();
    expect(await store.get('T-1')).toBeNull();
    await store.set('T-1', { version: 2, text: 'a', modelLines: [1] });
    expect(await store.get('T-1')).toEqual({ version: 2, text: 'a', modelLines: [1] });
    expect(await store.get('T-2')).toBeNull();
  });

  it('keeps the file store across instances and writes in order', async () => {
    const file = path.join(dir, 'home', 'plan-shadow.json');
    const store = new FilePlanShadowStore(file);
    await Promise.all([
      store.set('T-1', { version: 1, text: 'one', modelLines: [] }),
      store.set('T-2', { version: 1, text: 'two', modelLines: [2] }),
      store.set('T-1', { version: 2, text: 'one!', modelLines: [1] }),
    ]);
    const again = new FilePlanShadowStore(file);
    expect(await again.get('T-1')).toEqual({ version: 2, text: 'one!', modelLines: [1] });
    expect(await again.get('T-2')).toEqual({ version: 1, text: 'two', modelLines: [2] });
  });

  it('reads a missing or damaged file as no shadow', async () => {
    const file = path.join(dir, 'plan-shadow.json');
    expect(await new FilePlanShadowStore(file).get('T-1')).toBeNull();
    await fsp.writeFile(file, '{not json', 'utf8');
    expect(await new FilePlanShadowStore(file).get('T-1')).toBeNull();
    await fsp.writeFile(file, JSON.stringify({ 'T-1': { version: 'x', text: 3 } }), 'utf8');
    expect(await new FilePlanShadowStore(file).get('T-1')).toBeNull();
  });
});
