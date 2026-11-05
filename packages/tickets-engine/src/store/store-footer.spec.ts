import { describe, expect, it } from 'vitest';
import { storeFooterLine } from './store-footer';
import type { StoreSettings } from './store-settings';

const BASE: StoreSettings = {
  backend: 'dricket',
  shadow: false,
  dkPath: '',
  dkStore: 'E:\\dkv',
  dkDataDir: '',
  dkCheckout: '',
  dkSyncSeconds: 0,
};

const git = async (args: readonly string[]): Promise<string> => (args.includes('--abbrev-ref') ? 'tickets' : 'ab12cd3');

describe('storeFooterLine (D-9)', () => {
  it('describes a local store with its branch and head', async () => {
    expect(await storeFooterLine(BASE, git)).toBe('Ticket store E:\\dkv · branch tickets · head ab12cd3 · local store');
  });

  it('describes a remote store through its checkout and sync period', async () => {
    const line = await storeFooterLine({ ...BASE, dkStore: 'E:\\r.git#tickets', dkCheckout: 'E:\\co', dkSyncSeconds: 30 }, git);
    expect(line).toBe('Ticket store E:\\co · branch tickets · head ab12cd3 · synced every 30 s');
  });

  it('leaves out what git cannot say', async () => {
    const fail = async (): Promise<string> => {
      throw new Error('no git');
    };
    expect(await storeFooterLine(BASE, fail)).toBe('Ticket store E:\\dkv · local store');
  });
});
